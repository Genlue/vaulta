use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    env,
    io::{self, Read},
    process::ExitCode,
};
use vaulta::{database_path, locked, read};

const HELP: &str = concat!(
    "vaulta-agent ",
    env!("CARGO_PKG_VERSION"),
    " — 本地 JSON 协议 v1\n\n用法：\n  vaulta-agent list\n  vaulta-agent snapshot <vault-id>\n  vaulta-agent mutate <vault-id>    从标准输入读取单条 JSON 操作\n\n需要先在 Vaulta 的仓库设置授予对应仓库的 Agent 权限。"
);

fn run() -> Result<Option<Value>> {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".into());
    if ["-h", "--help", "help"].contains(&command.as_str()) {
        println!("{HELP}");
        return Ok(None);
    }
    if command == "--version" {
        println!("vaulta-agent {}", env!("CARGO_PKG_VERSION"));
        return Ok(None);
    }
    let id = args.next();
    ensure!(
        args.next().is_none(),
        "参数过多。请运行 vaulta-agent --help"
    );
    let database = database_path()?;
    if command == "list" && id.is_none() {
        if !database.exists() {
            return Ok(Some(json!({"protocol": 1, "vaults": []})));
        }
        return read(&database, |core| {
            let mut out = Vec::new();
            for vault in core.vaults()? {
                let access = core.agent_access(&vault.id)?;
                if access != "off" {
                    out.push(json!({"vault": vault, "access": access}));
                }
            }
            Ok(Some(json!({"protocol": 1, "vaults": out})))
        });
    }
    ensure!(
        matches!(command.as_str(), "snapshot" | "mutate"),
        "未知命令或参数。请运行 vaulta-agent --help"
    );
    let id = id.context("请提供仓库 ID")?;
    ensure!(database.exists(), "尚未创建可访问的 Vaulta 仓库");
    let action = if command == "mutate" {
        const LIMIT: u64 = 1024 * 1024;
        let mut input = Vec::new();
        io::stdin().lock().take(LIMIT + 1).read_to_end(&mut input)?;
        ensure!(input.len() as u64 <= LIMIT, "操作体积不能超过 1 MiB");
        let value: Value =
            serde_json::from_slice(input.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&input))?;
        match value.get("type").and_then(Value::as_str) {
            Some(
                "organize" | "category_save" | "category_delete" | "tag_create" | "tag_rename"
                | "tag_delete",
            ) => {}
            _ => bail!("Agent 只能操作分类、标签、标记和整理状态"),
        }
        if value.get("type").and_then(Value::as_str) == Some("organize") {
            ensure!(
                !matches!(value.get("state").and_then(Value::as_str), Some(s) if !matches!(s, "inbox" | "filed")),
                "Agent 不可排除文件或变更缺失状态"
            );
        }
        Some(serde_json::from_value(value)?)
    } else {
        None
    };
    if let Some(action) = action {
        locked(&database, |core| {
            let access = core.agent_access(&id)?;
            ensure!(access != "off", "该仓库未授予 Agent 访问权限");
            ensure!(access == "write", "该仓库只授予了读取权限");
            core.mutate(&id, action, "agent")?;
            Ok(Some(json!({"protocol": 1, "ok": true})))
        })
    } else {
        read(&database, |core| {
            let access = core.agent_access(&id)?;
            ensure!(access != "off", "该仓库未授予 Agent 访问权限");
            Ok(Some(
                json!({"protocol": 1, "snapshot": core.snapshot(&id)?}),
            ))
        })
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(output) => {
            if let Some(output) = output {
                println!("{output}");
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!(
                "{}",
                json!({"protocol":1,"ok":false,"error":format!("{err:#}")})
            );
            ExitCode::FAILURE
        }
    }
}
