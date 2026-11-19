use std::{fs, path::Path};

use rusqlite::params;

use crate::{
    audit, bump, filesystem, invalid, load_vault, path_starts, row, Core, Error, Result, Vault,
};

impl Core {
    /// Rebind an attached top-level vault to the same physical directory at a new path.
    /// Copies (including cross-volume copy-and-delete moves) are not the same directory.
    pub fn relocate_vault(&mut self, vault_id: &str, destination: &Path) -> Result<Vault> {
        let selection = filesystem::guarded(destination)?;
        if !selection.physical.directory {
            return Err(invalid("请选择仓库根文件夹，而不是文件。"));
        }
        let root = dunce::canonicalize(destination)
            .map_err(|e| Error::Filesystem(destination.into(), e))?;
        // Keep both the selected path and the canonical binding pinned through commit.
        let guard = filesystem::guarded(&root)?;
        if selection.physical.identity != guard.physical.identity {
            return Err(invalid("所选文件夹已变化，请重试。"));
        }
        let root_text = root
            .to_str()
            .ok_or_else(|| invalid("仓库路径必须可用 UTF-8 表示。"))?;

        let tx = self.write()?;
        let current = row(&tx, vault_id)?;
        if current.vault.parent_id.is_some() || !current.active {
            return Err(invalid("只能重定位仍在仓库列表中的顶层仓库。"));
        }
        {
            let mut stmt = tx.prepare(
                "SELECT root, root_identity FROM vaults
                 WHERE active=1 AND parent_id IS NULL AND id<>?1",
            )?;
            let mut rows = stmt.query([vault_id])?;
            while let Some(other) = rows.next()? {
                let other_path: String = other.get(0)?;
                let other_identity: String = other.get(1)?;
                if other_identity == guard.physical.identity
                    || paths_overlap(&root, Path::new(&other_path))
                {
                    return Err(invalid("所选文件夹与另一个已注册仓库重叠。"));
                }
            }
        }
        if current.root_identity != guard.physical.identity {
            return Err(invalid(
                "所选文件夹不是原仓库。请选择整体移动后的原文件夹；复制品或跨卷移动的目录无法安全重定位。",
            ));
        }
        // Reading attributes does not guarantee permission to enumerate a directory.
        fs::read_dir(&root).map_err(|e| Error::Filesystem(root.clone(), e))?;

        if current.vault.root != root {
            // Child vaults derive their roots from owning assets. Do not rewrite relative
            // paths or identities; invalidate any scan begun under the previous binding.
            tx.execute(
                "WITH RECURSIVE subtree(id) AS (
                    SELECT ?1 UNION ALL SELECT v.id FROM vaults v JOIN subtree s ON v.parent_id=s.id
                 ) UPDATE vaults SET scan_epoch=scan_epoch+1,
                    root=CASE WHEN id=?1 THEN ?2 ELSE root END,
                    status=CASE WHEN id=?1 THEN 'ready' ELSE status END
                   WHERE id IN (SELECT id FROM subtree)",
                params![vault_id, root_text],
            )?;
            audit(
                &tx,
                vault_id,
                "app",
                &format!(
                    "Relocated vault from {} to {}",
                    current.vault.root.display(),
                    root.display()
                ),
                None,
            )?;
            bump(&tx)?;
        }
        let vault = load_vault(&tx, vault_id)?;
        tx.commit()?;
        Ok(vault)
    }
}

fn paths_overlap(a: &Path, b: &Path) -> bool {
    // Keep long paths comparable to short ancestors even when dunce must retain the
    // verbatim syntax for the longer path. Both bindings are already canonical.
    fn comparison_path(path: &Path) -> std::borrow::Cow<'_, Path> {
        let text = path.to_str().expect("canonical vault paths are UTF-8");
        match text.strip_prefix(r"\\?\") {
            Some(path)
                if path
                    .get(..4)
                    .is_some_and(|p| p.eq_ignore_ascii_case(r"UNC\")) =>
            {
                std::borrow::Cow::Owned(format!(r"\\{}", &path[4..]).into())
            }
            Some(path) => std::borrow::Cow::Borrowed(Path::new(path)),
            None => std::borrow::Cow::Borrowed(Path::new(text)),
        }
    }
    let (a, b) = (comparison_path(a), comparison_path(b));
    path_starts(&a, &b) || path_starts(&b, &a)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn overlap_compares_drive_and_unc_aliases_on_component_boundaries() {
        assert!(paths_overlap(
            Path::new(r"\\?\c:\库\long\nested"),
            Path::new(r"C:\库")
        ));
        assert!(paths_overlap(
            Path::new(r"\\?\UNC\server\share\child"),
            Path::new(r"\\Server\Share")
        ));
        assert!(!paths_overlap(
            Path::new(r"\\?\C:\vault-two"),
            Path::new(r"C:\vault")
        ));
    }
}
