use serde::{Deserialize, Deserializer, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    pub parent_id: Option<String>,
    pub unit_id: Option<String>,
    pub view_enabled: bool,
    pub view_categories: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
    pub created: i64,
    pub category_id: Option<String>,
    pub tags: Vec<String>,
    pub flags: Vec<String>,
    pub state: String,
    pub identity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    pub time: i64,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub vault: Vault,
    pub assets: Vec<Asset>,
    pub categories: Vec<Category>,
    pub tags: Vec<String>,
    pub history: Vec<History>,
}

fn explicit_option<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Mutation {
    Organize {
        ids: Vec<String>,
        #[serde(
            default,
            deserialize_with = "explicit_option",
            skip_serializing_if = "Option::is_none"
        )]
        category_id: Option<Option<String>>,
        #[serde(default)]
        add_tags: Vec<String>,
        #[serde(default)]
        remove_tags: Vec<String>,
        #[serde(default)]
        add_flags: Vec<String>,
        #[serde(default)]
        remove_flags: Vec<String>,
        #[serde(default)]
        state: Option<String>,
    },
    CategorySave {
        #[serde(default)]
        id: Option<String>,
        name: String,
        #[serde(default)]
        parent_id: Option<String>,
    },
    CategoryDelete {
        id: String,
        #[serde(default)]
        reassign_to: Option<String>,
    },
    TagRename {
        name: String,
        new_name: String,
    },
    TagCreate {
        name: String,
    },
    TagDelete {
        name: String,
    },
    ViewConfig {
        enabled: bool,
        categories: Vec<String>,
    },
    Undo {},
    RecoverIdentity {
        missing_id: String,
        present_id: String,
    },
}
