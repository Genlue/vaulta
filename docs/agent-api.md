# 外部工具协议 v1

Vaulta 不启动 Agent。用户在仓库设置中为每个仓库（包括整体单元）分别选择 **关闭 / 只读 / 读写**。权限默认关闭。CLI 和界面读写同一个当前 Windows 用户的本地数据库；CLI 不开启服务、不需要端口，也没有真实文件移动、删除或执行命令。

这是一项**应用内接口授权**，不是 Windows 沙箱。已以同一用户运行的其他应用仍拥有该 Windows 用户的文件系统权限。

## 命令

安装目录或开发输出目录中的 `vaulta-agent.exe` 放在 `vaulta.exe` 旁边。可以从设置复制路径，也可以用绝对路径启动。

| 命令 | 对应权限 | stdout JSON |
|---|---|---|
| `vaulta-agent list` | 无（只返回已授权仓库） | `{"protocol":1,"vaults":[{"vault":{...},"access":"read"}]}` |
| `vaulta-agent snapshot <vault-id>` | 只读或读写 | `{"protocol":1,"snapshot":{...}}` |
| `vaulta-agent mutate <vault-id>` | 读写 | `{"protocol":1,"ok":true}` |

操作失败退出码非零，错误为 stderr 中的单行 JSON：`{"protocol":1,"ok":false,"error":"..."}`。信息内容可能有中文；输入输出为 UTF-8。操作在权限检查和数据库事务后生效；打开的桌面端会通过修订号感知并刷新。同一资产上先后成功的显式分类修改按提交顺序生效。

`snapshot` 包含：

- `vault`: `id`、`name`、`root`（绝对路径）、`parent_id`、`unit_id`、`status`、磁盘视图配置。
- `assets`: `id`（管理实体 ID）、`path`（以 `/` 分隔的仓库相对路径）、`name`、`kind`（`file`/`directory`/`unit`）、`size`（字节）、`created`、`modified`（Unix 毫秒）、`category_id`（可空）、`tags`、`flags`、`state`（`inbox`/`filed`/`excluded`/`missing`）、`identity`（不透明的物理身份凭据）。整体单元的内部文件用子空间的 `snapshot` 获取。
- `categories`: `id`、`name`、`parent_id`（根级为空）。`tags` 是仓库级标签词表。
- `history`: `time`（Unix 毫秒）、`source`、`message`。CLI 操作来源记为 `agent`。

开发或验证时可为桌面程序与 CLI 同时设置绝对路径环境变量 `VAULTA_DATA_DIR`，使用隔离的数据目录。

## 修改示例

标准输入传入一个最多 1 MiB 的 JSON 对象。支持：

```json
{"type":"organize","ids":["已查询的 asset ID"],"add_tags":["参考"],"remove_tags":[],"add_flags":["待处理"],"state":"filed"}
```

- `organize`：多个 `ids` 可一次更新。可选的 `category_id` 缺省表示保留，`null` 表示清除；`remove_flags`、`add_flags`、`remove_tags`、`add_tags` 为可选增量。`state` 可缺省、`inbox` 或 `filed`。
- `category_save`：`name` 必填，`id` 缺省创建；用 `parent_id` 指定父分类或 `null` 指定根级。
- `category_delete`：`id` 必填，`reassign_to` 为可选的重分配分类 ID；不会删除真实资产。
- `tag_create` / `tag_delete`：`name`。
- `tag_rename`：`name` 与 `new_name`。

PowerShell 7 使用示例（把变量里的示意值换成 `list` / `snapshot` 返回的实际值）：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
& $agent list
& $agent snapshot $vaultId
@{ type='organize'; ids=@($assetId); add_tags=@('参考') } |
  ConvertTo-Json -Compress | & $agent mutate $vaultId
```

