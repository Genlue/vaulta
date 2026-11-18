mod filesystem;
mod metadata;
mod model;
mod reconcile;

pub use filesystem::identity;
pub use model::{Asset, Category, History, Mutation, Snapshot, Vault};

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("{0} not found: {1}")]
    NotFound(&'static str, String),
    #[error("filesystem error at {0}: {1}")]
    Filesystem(PathBuf, #[source] std::io::Error),
    #[error("metadata database: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("metadata encoding: {0}")]
    Encoding(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

pub struct Core {
    db: Connection,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
fn missing(kind: &'static str, id: &str) -> Error {
    Error::NotFound(kind, id.into())
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn name(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(invalid(
            "expected a nonempty name without control characters (up to 1024 bytes)",
        ));
    }
    Ok(value)
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn json<T: DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    serde_json::from_str(row.get_ref(index)?.as_str()?).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(e))
    })
}

#[derive(Debug)]
struct VaultRow {
    vault: Vault,
    root_identity: String,
    active: bool,
    epoch: i64,
}

#[derive(Debug, PartialEq, Eq)]
struct Binding {
    // Ordered from top-level to leaf. Each path/identity pair is independently checked.
    chain: Vec<(PathBuf, String)>,
    // Missing or excluded owning units are never resolved as live child spaces.
    blocked: bool,
}

impl Binding {
    fn root(&self) -> &Path {
        &self.chain.last().expect("nonempty vault binding").0
    }

    fn check(&self) -> Result<filesystem::Guarded> {
        if self.blocked {
            return Err(invalid("the owning folder unit is missing or excluded"));
        }
        let mut previous = Vec::new();
        for (path, identity) in &self.chain {
            let guard = filesystem::guarded(path)?;
            if !guard.physical.directory || &guard.physical.identity != identity {
                return Err(invalid(format!(
                    "vault root identity changed: {}",
                    path.display()
                )));
            }
            previous.push(guard);
        }
        let mut last = previous.pop().expect("nonempty vault binding");
        for guard in previous {
            last.ancestors.push(guard.handle);
            last.ancestors.extend(guard.ancestors);
        }
        Ok(last)
    }
}

impl Core {
    /// Open the shared metadata database; no connection or mutex needs to cross threads.
    pub fn open(db_path: &Path) -> Result<Self> {
        let mut db = Connection::open(db_path)?;
        db.busy_timeout(Duration::from_secs(8))?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        let version = db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))?;
        if version != 1 {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            match tx.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? {
                0 => {
                    tx.execute_batch(include_str!("schema.sql"))?;
                    tx.pragma_update(None, "user_version", 1)?;
                }
                1 => (),
                other => {
                    return Err(invalid(format!(
                        "unsupported Vaulta database version {other}"
                    )))
                }
            }
            tx.commit()?;
        }
        Ok(Self { db })
    }

    fn write(&mut self) -> Result<Transaction<'_>> {
        Ok(self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?)
    }

    /// Durable, cross-connection marker for visible metadata and scan changes.
    pub fn revision(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT revision FROM settings WHERE id=1", [], |r| r.get(0))?)
    }

    pub fn vaults(&self) -> Result<Vec<Vault>> {
        let tx = self.db.unchecked_transaction()?;
        let ids = {
            let mut stmt = tx.prepare("WITH RECURSIVE attached(id) AS (
                SELECT id FROM vaults WHERE parent_id IS NULL AND active=1
                UNION ALL SELECT v.id FROM vaults v JOIN attached a ON v.parent_id=a.id
            ) SELECT v.id FROM vaults v JOIN attached a ON a.id=v.id ORDER BY v.name COLLATE NOCASE, v.id")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let vaults = ids
            .iter()
            .map(|id| load_vault(&tx, id))
            .collect::<Result<_>>()?;
        tx.commit()?;
        Ok(vaults)
    }

    pub fn get_vault(&self, id: &str) -> Result<Vault> {
        let tx = self.db.unchecked_transaction()?;
        let vault = load_vault(&tx, id)?;
        tx.commit()?;
        Ok(vault)
    }

    /// Verify the root and owning units against live Windows identities, even before a scan.
    /// Callers still need to validate/pin their target at the point of I/O.
    pub fn checked_root(&self, id: &str) -> Result<PathBuf> {
        let tx = self.db.unchecked_transaction()?;
        let (_, binding) = binding(&tx, id)?;
        tx.commit()?;
        let _guard = binding.check()?;
        let tx = self.db.unchecked_transaction()?;
        let (_, current) = self::binding(&tx, id)?;
        if current != binding {
            return Err(invalid("vault root changed; retry"));
        }
        tx.commit()?;
        Ok(binding.root().into())
    }

    pub fn add_vault(&mut self, root: &Path, display_name: &str) -> Result<Vault> {
        let display_name = name(display_name)?;
        let absolute = std::path::absolute(root).map_err(|e| Error::Filesystem(root.into(), e))?;
        let original = filesystem::guarded(&absolute)?;
        if !original.physical.directory {
            return Err(invalid("vault root must be a directory"));
        }
        let root = dunce::canonicalize(&absolute).map_err(|e| Error::Filesystem(absolute, e))?;
        let guard = filesystem::guarded(&root)?;
        if guard.physical.identity != original.physical.identity {
            return Err(invalid("vault root changed while being registered"));
        }
        // A metadata-only handle need not imply the root is listable.
        std::fs::read_dir(&root).map_err(|e| Error::Filesystem(root.clone(), e))?;
        let root_text = root
            .to_str()
            .ok_or_else(|| invalid("vault root is not UTF-8"))?;
        let tx = self.write()?;
        let roots = {
            let mut stmt = tx.prepare(
                "SELECT id, root, root_identity, active FROM vaults WHERE parent_id IS NULL",
            )?;
            let roots = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, PathBufString>(1)?.0,
                        r.get::<_, String>(2)?,
                        r.get::<_, bool>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            roots
        };
        let mut reattach = None;
        for (id, path, key, active) in roots {
            if key == guard.physical.identity
                && path_starts(&root, &path)
                && path_starts(&path, &root)
            {
                if active {
                    return Err(invalid("this root is already registered"));
                }
                reattach = Some(id);
            } else if active
                && (key == guard.physical.identity
                    || path_starts(&root, &path)
                    || path_starts(&path, &root))
            {
                return Err(invalid("vault root overlaps a registered vault"));
            }
        }
        let (id, message) = match reattach {
            Some(id) => {
                tx.execute("UPDATE vaults SET active=1, name=?2, root=?3, status='ready', scan_epoch=scan_epoch+1 WHERE id=?1", params![id, display_name, root_text])?;
                (id, "Reattached vault")
            }
            None => {
                let id = id();
                tx.execute(
                    "INSERT INTO vaults(id, name, root, root_identity) VALUES(?1, ?2, ?3, ?4)",
                    params![id, display_name, root_text, guard.physical.identity],
                )?;
                metadata::seed_categories(&tx, &id)?;
                (id, "Registered vault")
            }
        };
        audit(&tx, &id, "app", message, None)?;
        bump(&tx)?;
        let vault = load_vault(&tx, &id)?;
        tx.commit()?;
        Ok(vault)
    }

    pub fn rename_vault(&mut self, id: &str, display_name: &str) -> Result<()> {
        let display_name = name(display_name)?;
        let tx = self.write()?;
        let (row, _) = binding(&tx, id)?;
        if row.vault.name != display_name {
            tx.execute(
                "UPDATE vaults SET name=?2 WHERE id=?1",
                params![id, display_name],
            )?;
            audit(
                &tx,
                id,
                "app",
                &format!("Renamed vault to {display_name}"),
                None,
            )?;
            bump(&tx)?;
        }
        Ok(tx.commit()?)
    }

    /// Detach a top-level vault without deleting metadata, child spaces or physical files.
    pub fn remove_vault(&mut self, id: &str) -> Result<()> {
        let tx = self.write()?;
        let (row, _) = binding(&tx, id)?;
        if row.vault.parent_id.is_some() {
            return Err(invalid("only top-level vaults can be detached"));
        }
        // Reattaching must never silently restore an earlier external grant.
        tx.execute("WITH RECURSIVE subtree(id) AS (SELECT ?1 UNION ALL SELECT v.id FROM vaults v JOIN subtree s ON v.parent_id=s.id)
                    UPDATE vaults SET agent_access='off', scan_epoch=scan_epoch+1 WHERE id IN subtree", [id])?;
        tx.execute("UPDATE vaults SET active=0 WHERE id=?1", [id])?;
        audit(
            &tx,
            id,
            "app",
            "Detached vault and revoked agent access",
            None,
        )?;
        bump(&tx)?;
        Ok(tx.commit()?)
    }

    pub fn snapshot(&self, id: &str) -> Result<Snapshot> {
        let tx = self.db.unchecked_transaction()?;
        let vault = load_vault(&tx, id)?;
        let assets = {
            let mut stmt = tx.prepare(&format!("SELECT {ASSET_COLUMNS} FROM assets WHERE vault_id=?1 AND shadowed=0 ORDER BY path, missing, id"))?;
            let rows = stmt
                .query_map([id], read_asset)?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        let categories = metadata::categories(&tx, id)?;
        let tags = metadata::tags(&tx, id)?;
        let history = {
            let mut stmt = tx.prepare("SELECT time, source, message FROM history WHERE vault_id=?1 ORDER BY seq DESC LIMIT 200")?;
            let rows = stmt
                .query_map([id], |row| {
                    Ok(History {
                        time: row.get(0)?,
                        source: row.get(1)?,
                        message: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        tx.commit()?;
        Ok(Snapshot {
            vault,
            assets,
            categories,
            tags,
            history,
        })
    }

    pub fn asset(&self, vault_id: &str, asset_id: &str) -> Result<Asset> {
        let tx = self.db.unchecked_transaction()?;
        binding(&tx, vault_id)?;
        let asset = load_asset(&tx, vault_id, asset_id)?;
        tx.commit()?;
        Ok(asset)
    }

    pub fn record(&mut self, vault_id: &str, source: &str, message: &str) -> Result<()> {
        let tx = self.write()?;
        binding(&tx, vault_id)?;
        audit(&tx, vault_id, name(source)?, message, None)?;
        bump(&tx)?;
        Ok(tx.commit()?)
    }

    pub fn agent_access(&self, vault_id: &str) -> Result<String> {
        let tx = self.db.unchecked_transaction()?;
        binding(&tx, vault_id)?;
        let access = tx.query_row(
            "SELECT agent_access FROM vaults WHERE id=?1",
            [vault_id],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(access)
    }

    pub fn set_agent_access(&mut self, vault_id: &str, access: &str) -> Result<()> {
        if !matches!(access, "off" | "read" | "write") {
            return Err(invalid("agent access must be off, read, or write"));
        }
        let tx = self.write()?;
        binding(&tx, vault_id)?;
        if tx.execute(
            "UPDATE vaults SET agent_access=?2 WHERE id=?1 AND agent_access<>?2",
            params![vault_id, access],
        )? != 0
        {
            audit(
                &tx,
                vault_id,
                "app",
                &format!("Agent access set to {access}"),
                None,
            )?;
            bump(&tx)?;
        }
        Ok(tx.commit()?)
    }
}

struct PathBufString(PathBuf);
impl rusqlite::types::FromSql for PathBufString {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        Ok(Self(value.as_str()?.into()))
    }
}

fn path_starts(path: &Path, prefix: &Path) -> bool {
    let mut parts = path.components();
    prefix.components().all(|b| {
        parts
            .next()
            .is_some_and(|a| filesystem::same_name(a.as_os_str(), b.as_os_str()))
    })
}

fn row(db: &Connection, id: &str) -> Result<VaultRow> {
    db.query_row("SELECT id,name,root,parent_id,unit_id,view_enabled,view_categories,status,root_identity,active,scan_epoch FROM vaults WHERE id=?1", [id], |r| Ok(VaultRow {
        vault: Vault { id: r.get(0)?, name: r.get(1)?, root: r.get::<_,PathBufString>(2)?.0, parent_id: r.get(3)?, unit_id: r.get(4)?, view_enabled: r.get(5)?, view_categories: json(r,6)?, status: r.get(7)? },
        root_identity: r.get(8)?, active: r.get(9)?, epoch: r.get(10)?,
    })).optional()?.ok_or_else(|| missing("vault", id))
}

fn binding(db: &Connection, id: &str) -> Result<(VaultRow, Binding)> {
    let leaf = row(db, id)?;
    let mut blocked = false;
    let mut rel = Vec::new();
    let mut current = None;
    loop {
        let r = current.as_ref().unwrap_or(&leaf);
        match (&r.vault.parent_id, &r.vault.unit_id) {
            (Some(parent), Some(unit)) => {
                let (path, asset_id, unavailable) = db.query_row("SELECT path, identity, missing OR shadowed OR state='excluded' FROM assets WHERE vault_id=?1 AND id=?2 AND kind='unit'", params![parent, unit], |r| {
                    Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,bool>(2)?))
                }).optional()?.ok_or_else(|| missing("owning unit", unit))?;
                blocked |= unavailable || asset_id != r.root_identity;
                rel.push((filesystem::relative(&path)?, r.root_identity.clone()));
                if rel.len() > 256 {
                    return Err(invalid("vault nesting limit exceeded"));
                }
                current = Some(row(db, parent)?);
            }
            (None, None) => {
                if !r.active {
                    return Err(missing("attached vault", id));
                }
                let mut root = r.vault.root.clone();
                let mut chain = vec![(root.clone(), r.root_identity.clone())];
                for (path, identity) in rel.into_iter().rev() {
                    root.push(path);
                    chain.push((root.clone(), identity));
                }
                return Ok((leaf, Binding { chain, blocked }));
            }
            _ => return Err(invalid("inconsistent vault parent binding")),
        }
    }
}

fn load_vault(db: &Connection, id: &str) -> Result<Vault> {
    let (r, b) = binding(db, id)?;
    let mut vault = r.vault;
    vault.root = b.root().into();
    if b.blocked {
        vault.status = "unavailable".into();
    }
    Ok(vault)
}

const ASSET_COLUMNS: &str = "id,path,kind,size,modified,created,category_id,tags,flags,CASE WHEN missing THEN 'missing' ELSE state END,identity";
fn read_asset(r: &Row<'_>) -> rusqlite::Result<Asset> {
    let path: String = r.get(1)?;
    let name = path.rsplit('/').next().unwrap_or_default().into();
    Ok(Asset {
        id: r.get(0)?,
        path,
        name,
        kind: r.get(2)?,
        size: r.get(3)?,
        modified: r.get(4)?,
        created: r.get(5)?,
        category_id: r.get(6)?,
        tags: json(r, 7)?,
        flags: json(r, 8)?,
        state: r.get(9)?,
        identity: r.get(10)?,
    })
}
fn load_asset(db: &Connection, vault: &str, id: &str) -> Result<Asset> {
    db.query_row(
        &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE vault_id=?1 AND id=?2 AND shadowed=0"),
        params![vault, id],
        read_asset,
    )
    .optional()?
    .ok_or_else(|| missing("asset", id))
}

fn bump(db: &Connection) -> Result<()> {
    db.execute("UPDATE settings SET revision=revision+1 WHERE id=1", [])?;
    Ok(())
}

fn audit(
    db: &Connection,
    vault: &str,
    source: &str,
    message: &str,
    undo: Option<&str>,
) -> Result<()> {
    db.execute(
        "INSERT INTO history(vault_id,time,source,message,undo) VALUES(?1,?2,?3,?4,?5)",
        params![vault, now(), source, message, undo],
    )?;
    Ok(())
}

fn same_component(a: &str, b: &str) -> bool {
    filesystem::same_name(OsStr::new(a), OsStr::new(b))
}
