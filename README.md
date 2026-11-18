# 大型交付压缩包的选择性资料领取

当前领取授权清单及资料包位置。来源拒绝整包获取，原始收件对象可保存合法范围响应。

## 运行

使用 Node.js 22。依赖版本已锁定，运行、测试和演示不下载任何数据或软件。运行时只使用 Node.js 内置模块。

- `npm test`：执行本地来源交互、ZIP 结构、范围读取及收件存储测试。
- `npm run build`：逐个检查模块语法。
- `npm run demo`：启动本地来源，运行完整授权成员领取，打印逐成员结论、实际内容与范围请求统计后退出。
- `npm start`：在 127.0.0.1:8080 启动本地来源，PORT 可调整。`GET /health` 返回服务与当前来源版本；原有 `/_health` 仍可使用。

容器方式：`docker build -t collection-remote-zip .`，然后 `docker run --rm --network none collection-remote-zip`。镜像构建属于环境准备，运行时不访问公网。

## 项目结构

- `src/domain.mjs`：业务入口。`receiveCurrent` 领取授权清单；`receiveAuthorizedMembers` 执行远端成员领取；`resumeAuthorizedMembers` 恢复未完成作业。
- `src/zip.mjs`：纯 ZIP 结构解析与校验，支持经典 EOCD、ZIP64 EOCD/locator、Stored/Deflate、UTF-8 文件名、数据描述符；多卷结构明确拒绝。
- `src/remote.mjs`：`RemoteRangeReader` 只发单一字节范围、只接受 206，并以 ETag/If-Match 绑定资料包版本，带单响应与累计传输预算。
- `src/collect.mjs`：选择性领取编排、成员状态判定、作业状态落盘与恢复。
- `src/client.mjs`：人工指定地址的有限大小原始领取（授权清单）。
- `src/archive.mjs`：按内容哈希保存对象与来源凭据。
- `provider/` 是独立的本地来源服务，`docs/source-contract.md` 说明它的资料和状态约定。

## 领取流程与判定

1. 先领取并保存 `/delivery` 授权清单，得到资料包地址、版本与授权成员名称。
2. 读取资料包末尾至多 65557 字节定位 EOCD（必要时经 ZIP64 locator/EOCD），再按 EOCD 给出的偏移与体积读取中央目录。
3. 授权名称只做精确匹配，不做前缀或相似名扩大：
   - 目录中没有该名称 → `missing`；
   - 同名出现多个成员 → `ambiguous`，列出全部候选的 ordinal 与局部头偏移，不任选其一；
   - 唯一匹配才继续。
4. 读取该成员局部头并与中央目录逐项核对（文件名、压缩方式、标志、CRC、压缩/解压大小）。数据描述符成员在取完数据后还要实际读取并核对描述符。任何不一致 → `inconsistent`，停止碰运气式读取，不保存内容。
5. 按 Stored/Deflate 还原内容，校验解压后大小与 CRC32，通过后才写入收件存储，并在凭据中保留成员名、ordinal、资料包 ETag、版本与授权清单凭据的对应关系。
6. 网络或校验过程失败但结构无冲突 → `incomplete`；加密成员或不支持的压缩方式 → `unsupported`。

结论按成员给出：`obtained` / `ambiguous` / `missing` / `incomplete` / `inconsistent` / `unsupported`，而不是只报告下载请求成功。作业状态原子写入 `jobs/`，每次成员结论变化都落盘。

## 版本绑定与恢复

所有范围请求都携带 `If-Match`。领取期间来源换版：

- 发现阶段（尚未定位成员）收到 412，允许以新版本重新发现一次；
- 成员数据读取途中换版，作业以未完成状态落盘并抛出 `VersionConflictError`，不静默重来。

恢复作业先发送一次带旧 ETag 的范围探测：412 表示旧偏移依据的版本已失效，直接抛出冲突，由调用方重新领取清单；探测通过才继续，且已 `obtained` 的成员不会重复领取。

## 边界

范围读取器同时限制单次响应与累计传输体积（默认 8 MiB / 32 MiB），中央目录与单个成员另有读取预算；所有请求必须是单一范围且返回 206，合并覆盖范围不得覆盖整包，从机制上杜绝以大范围逐步拼回整包。

本地服务中的机构、记录和文件都是合成业务资料，不使用真实账号、个人信息或第三方站点数据。当前演示通常十秒内结束，全部本地测试应在六十秒内结束。
