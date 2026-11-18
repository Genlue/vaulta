CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
);
INSERT INTO settings VALUES (1, 0);

CREATE TABLE vaults (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    root TEXT NOT NULL,
    root_identity TEXT NOT NULL,
    parent_id TEXT REFERENCES vaults(id),
    unit_id TEXT UNIQUE REFERENCES assets(id),
    active INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ready',
    scan_epoch INTEGER NOT NULL DEFAULT 0,
    agent_access TEXT NOT NULL DEFAULT 'off',
    view_enabled INTEGER NOT NULL DEFAULT 0,
    view_categories TEXT NOT NULL DEFAULT '[]',
    CHECK ((parent_id IS NULL) = (unit_id IS NULL))
);
CREATE INDEX vault_by_parent ON vaults(parent_id);

CREATE TABLE categories (
    vault_id TEXT NOT NULL REFERENCES vaults(id),
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT,
    PRIMARY KEY (vault_id, id),
    FOREIGN KEY (vault_id, parent_id) REFERENCES categories(vault_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE tags (
    vault_id TEXT NOT NULL REFERENCES vaults(id),
    name TEXT NOT NULL,
    PRIMARY KEY (vault_id, name)
);
CREATE TABLE assets (
    id TEXT PRIMARY KEY NOT NULL,
    vault_id TEXT NOT NULL REFERENCES vaults(id),
    path TEXT NOT NULL COLLATE BINARY,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'directory', 'unit')),
    size INTEGER NOT NULL,
    modified INTEGER NOT NULL,
    created INTEGER NOT NULL,
    identity TEXT NOT NULL,
    links INTEGER NOT NULL,
    missing INTEGER NOT NULL DEFAULT 0,
    shadowed INTEGER NOT NULL DEFAULT 0,
    category_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    flags TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'inbox' CHECK (state IN ('inbox', 'filed', 'excluded')),
    FOREIGN KEY (vault_id, category_id) REFERENCES categories(vault_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX asset_live_path ON assets(vault_id, path) WHERE missing = 0;
CREATE INDEX asset_by_identity ON assets(vault_id, identity);

CREATE TABLE history (
    seq INTEGER PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id),
    time INTEGER NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    undo TEXT,
    undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX history_by_vault ON history(vault_id, seq DESC);


