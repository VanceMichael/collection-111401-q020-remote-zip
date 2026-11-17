# 大型交付压缩包的选择性资料领取

当前领取授权清单及资料包位置。来源拒绝整包获取，原始收件对象可保存合法范围响应。

## 运行

使用 Node.js 22。依赖版本已锁定，运行、测试和演示不下载任何数据或软件。运行时只使用 Node.js 内置模块。

- `npm test`：执行本地来源交互及收件存储测试。
- `npm run build`：逐个检查模块语法。
- `npm run demo`：启动本地来源，运行当前领取流程，打印真实收件结果后退出。
- `npm start`：在 127.0.0.1:8080 启动本地来源，PORT 可调整。`GET /health` 返回服务与当前来源版本；原有 `/_health` 仍可使用。

容器方式：`docker build -t collection-remote-zip .`，然后 `docker run --rm --network none collection-remote-zip`。镜像构建属于环境准备，运行时不访问公网。

## 项目结构

`src/domain.mjs` 提供当前业务读取入口（`receiveAuthorized` 按授权清单领取压缩包成员）；`src/client.mjs` 负责人工指定地址的有限大小原始领取；`src/archive.mjs` 保存内容及来源凭据。`src/remotemembers.mjs` 经来源目录的单范围请求领取授权成员，绑定压缩包版本、处理换版与续领，并写出成员—版本—清单对应的清单凭据；`src/zipdir.mjs` 解析结束目录（含 ZIP64）、中央目录、局部头与数据描述符并校验内容。`provider/` 是独立的本地来源服务，`docs/source-contract.md` 说明它的资料和状态约定。演示使用临时目录，正式接入可向业务入口传入持久目录。

本地服务中的机构、记录和文件都是合成业务资料，不使用真实账号、个人信息或第三方站点数据。当前演示通常十秒内结束，全部本地测试应在六十秒内结束。
