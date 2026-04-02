# NFS-Based Service Injection — 部署与复制指南

> 通过 NFS 共享目录 `.d2vm/` 向任意 K8s 容器注入 Jupyter、VNC、code-server、OpenCode Web 等开发服务。
> 无需 sidecar、无需修改容器镜像、无需容器内包管理器。

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  NFS Server (e.g. 192.168.3.38)                         │
│  /data/nfs/VM/.d2vm/                                    │
│  ├── scripts/       # 启动脚本 (entrypoint + helpers)   │
│  └── services/      # 静态二进制 (~740MB)               │
│      ├── opencode/amd64/opencode     # 166MB            │
│      ├── code-server/amd64/          # 492MB            │
│      ├── TigerVNC/amd64/             # 33MB             │
│      ├── noVNC/                      # 3MB              │
│      ├── websocat/amd64/             # 7.5MB            │
│      └── uv/amd64/                   # 42MB             │
└─────────────────────────────────────────────────────────┘
              │ NFS mount (read-only)
              ▼
┌─────────────────────────────────────────────────────────┐
│  K8s Pod (任意容器镜像)                                  │
│  mountPath: /.d2vm  (from NFS)                          │
│                                                         │
│  entrypoint: /.d2vm/scripts/base_cmd_test.sh            │
│  args: $PASSWORD $DURATION $SSH_PORT $JOB_NAME ...      │
│                                                         │
│  环境变量 (feature flags):                               │
│    ENABLE_JUPYTER=true/false                             │
│    ENABLE_VNC=true/false                                 │
│    ENABLE_CODE_SERVER=true/false                         │
│    ENABLE_OPENCODE_WEB=true/false                        │
│                                                         │
│  服务端口:                                               │
│    8888  → Jupyter Lab/Notebook                          │
│    5099  → noVNC (Web VNC)                               │
│    8443  → code-server                                   │
│    8172  → OpenCode Web                                  │
│    22    → SSH                                           │
└─────────────────────────────────────────────────────────┘
              │ Ingress / Caddy reverse proxy
              ▼
┌─────────────────────────────────────────────────────────┐
│  用户浏览器访问:                                         │
│    /jupyter/{JOB_NAME}/     → Pod:8888                   │
│    /vnc/{JOB_NAME}/vnc.html → Pod:5099                   │
│    /code-server/{JOB_NAME}/ → Pod:8443                   │
│    /opencode/{JOB_NAME}/    → Pod:8172                   │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 前置条件

| 条件 | 说明 |
|------|------|
| NFS 服务器 | 任意 Linux 节点，支持 NFSv4，有足够存储 (~1GB) |
| K8s 集群 | 需能挂载 NFS PV/PVC 或 `nfs` 类型 volume |
| 构建环境 (可选) | 仅在需要构建 OpenCode fork 时需要：Linux x86_64 + Bun ≥ 1.1 |
| 反向代理 | Caddy / Nginx / Ingress Controller，支持 path-based 路由和 WebSocket |

---

## 3. 准备 NFS 共享目录

### 3.1 创建目录结构

```bash
NFS_ROOT="/data/nfs/VM"  # 改成你的 NFS 导出路径
mkdir -p ${NFS_ROOT}/.d2vm/{scripts,services}
```

### 3.2 使用自动化脚本填充 (推荐)

`setup-share-services.sh` 可自动下载并解压大部分服务二进制：

```bash
# 在 NFS 服务器上执行
bash setup-share-services.sh
```

该脚本处理以下服务的自动下载：
- **code-server**: 从 GitHub Releases 下载，自动检测 amd64/arm64
- **TigerVNC**: 从 GitHub Releases 下载并解压
- **noVNC**: 从 GitHub Releases 下载
- **websocat**: 从 GitHub Releases 下载
- **uv** (Python 包管理器): 从 GitHub Releases 下载

### 3.3 构建 OpenCode (fork 版本)

OpenCode 使用了自定义 fork (`yuanwuzhi/opencode`, branch `feature/base-path-support`)，
增加了 `--base-path` 支持以适配反向代理部署。**必须手动构建**。

```bash
# 1. 克隆 fork
git clone -b feature/base-path-support https://github.com/yuanwuzhi/opencode.git /tmp/opencode-fork

# 2. 安装依赖 (需要 Bun >= 1.1)
cd /tmp/opencode-fork
bun install

# 3. 缓存 models.dev API JSON (构建时需要，直接 fetch 可能不稳定)
curl -o /tmp/models-api.json https://models.dev/api.json

# 4. 构建单文件二进制 (含内嵌 Web UI)
cd packages/opencode
MODELS_DEV_API_JSON=/tmp/models-api.json bun run script/build.ts --single --skip-install
# 注意: 不要加 --skip-embed-web-ui，前端必须打包进二进制

# 5. 部署到 NFS
cp dist/opencode-linux-x64/bin/opencode ${NFS_ROOT}/.d2vm/services/opencode/amd64/opencode
chmod +x ${NFS_ROOT}/.d2vm/services/opencode/amd64/opencode
```

> **注意**: 当前 OpenCode 仅支持 x86_64 (amd64)。arm64 架构会被启动脚本跳过。

### 3.4 部署脚本

将以下脚本复制到 `${NFS_ROOT}/.d2vm/scripts/`：

| 脚本 | 作用 | 必需 |
|------|------|------|
| `base_cmd_test.sh` | 容器入口脚本，启动 SSH + 各服务 | ✅ |
| `set_password.sh` | Jupyter + VNC 启动与密码配置 | ✅ |
| `jupyter_passwd_expect.sh` | Jupyter 密码设置 (expect) | ✅ (if Jupyter) |
| `vnc_passwd_expect.sh` | VNC 密码设置 (expect) | ✅ (if VNC) |
| `setup-share-services.sh` | NFS 目录填充脚本 | 仅首次 |

### 3.5 导出 NFS 共享

```bash
# /etc/exports 添加:
/data/nfs/VM  *(rw,sync,no_subtree_check,no_root_squash)

# 生效
exportfs -ra
systemctl restart nfs-server
```

### 3.6 最终目录结构验证

```
.d2vm/
├── scripts/
│   ├── base_cmd_test.sh          # 容器入口点
│   ├── set_password.sh           # Jupyter/VNC 启动
│   ├── jupyter_passwd_expect.sh
│   ├── vnc_passwd_expect.sh
│   └── setup-share-services.sh   # NFS 填充脚本 (可选保留)
└── services/
    ├── code-server/
    │   └── amd64/bin/code-server
    ├── opencode/
    │   └── amd64/opencode
    ├── TigerVNC/
    │   └── amd64/usr/{bin,lib64,libexec}/
    ├── noVNC/
    │   ├── vnc.html
    │   └── utils/novnc_proxy
    ├── websocat/
    │   └── amd64/websocat
    └── uv/
        └── amd64/uv
```

---

## 4. K8s 配置

### 4.1 NFS Volume 定义

在 Pod spec 中添加 NFS volume：

```yaml
volumes:
  - name: d2vm-services
    nfs:
      server: <NFS_SERVER_IP>      # 例如 192.168.3.38
      path: /data/nfs/VM/.d2vm
      readOnly: true               # 服务二进制不需要写入
  - name: workspace
    persistentVolumeClaim:
      claimName: user-workspace-pvc  # 用户持久数据
```

### 4.2 Container 配置

```yaml
containers:
  - name: dev-env
    image: <任意基础镜像>           # Ubuntu, PyTorch, TensorFlow, etc.
    command: ["/.d2vm/scripts/base_cmd_test.sh"]
    args:
      - "$(PASSWORD)"              # $1: SSH/服务密码
      - "$(DURATION)"              # $2: 容器运行时长(秒)
      - "22"                       # $3: SSH 端口
      - "$(JOB_NAME)"             # $4: Job 名称 (用于 URL 路径)
      - "$(MASTER_IP)"            # $5: 主节点 IP
      - "$(MASTER_PORT)"          # $6: 主节点端口
      - "$(FINISHED_URL)"         # $7: 完成回调 URL (可选)
    env:
      - name: ENABLE_JUPYTER
        value: "true"
      - name: ENABLE_VNC
        value: "true"
      - name: ENABLE_CODE_SERVER
        value: "true"
      - name: ENABLE_OPENCODE_WEB
        value: "true"
    volumeMounts:
      - name: d2vm-services
        mountPath: /.d2vm
        readOnly: true
      - name: workspace
        mountPath: /workspace
    ports:
      - containerPort: 22    # SSH
      - containerPort: 8888  # Jupyter
      - containerPort: 5099  # noVNC
      - containerPort: 8443  # code-server
      - containerPort: 8172  # OpenCode Web
```

### 4.3 Feature Flags

通过环境变量控制哪些服务启动，**所有服务默认关闭** (`false`)：

| 环境变量 | 服务 | 端口 | 说明 |
|----------|------|------|------|
| `ENABLE_JUPYTER` | Jupyter Lab/Notebook | 8888 | 优先使用镜像内预装的 jupyter，否则用 uv/uvx 临时启动 |
| `ENABLE_VNC` | TigerVNC + noVNC | 5099 (web), 5901 (vnc) | 需要容器内有 X11 桌面环境 (如 XFCE) |
| `ENABLE_CODE_SERVER` | code-server (VS Code) | 8443 | 独立运行，无额外依赖 |
| `ENABLE_OPENCODE_WEB` | OpenCode Web IDE | 8172 | 仅 amd64，使用 `--base-path` 模式 |

---

## 5. 反向代理 / Ingress 配置

所有服务通过 path-based 路由暴露，URL 格式固定为 `/{service}/{JOB_NAME}/`。

### 5.1 Caddy 配置示例

```caddyfile
# 假设域名: dev.example.com
# Pod 通过 K8s Service 暴露，或直接用 Pod IP

dev.example.com {
    # Jupyter
    handle_path /jupyter/{job_name}/* {
        reverse_proxy {upstream}:8888 {
            header_up X-Real-IP {remote_host}
        }
    }

    # VNC (noVNC) — 需要 WebSocket 支持
    handle_path /vnc/{job_name}/* {
        reverse_proxy {upstream}:5099 {
            header_up X-Real-IP {remote_host}
        }
    }

    # code-server
    handle_path /code-server/{job_name}/* {
        reverse_proxy {upstream}:8443 {
            header_up X-Real-IP {remote_host}
        }
    }

    # OpenCode Web — 需要 WebSocket 支持
    handle /opencode/{job_name}/* {
        # 注意: OpenCode 使用 --base-path，不要 strip prefix
        reverse_proxy {upstream}:8172 {
            header_up X-Real-IP {remote_host}
        }
    }
}
```

### 5.2 关键注意事项

| 服务 | Path Strip | WebSocket | 认证方式 |
|------|-----------|-----------|----------|
| Jupyter | ❌ 不 strip (base_url 已配置) | ✅ 需要 | Token/Password |
| VNC | ❌ 不 strip | ✅ **必须** (WebSocket 连接 VNC) | VNC Password |
| code-server | ✅ strip prefix | ✅ 需要 | Password (config.yaml) |
| OpenCode | ❌ **绝不 strip** (--base-path 处理) | ✅ **必须** (SSE/realtime) | HTTP Basic Auth |

> **OpenCode 特别注意**: `--base-path /opencode/{JOB_NAME}/` 已内建在二进制中处理路径前缀。
> 反向代理**不能** strip path，否则 API 路由会断裂。

---

## 6. OpenCode Fork 变更说明

### 6.1 核心改动

本 fork (`yuanwuzhi/opencode`, branch `feature/base-path-support`) 在上游基础上增加了以下功能：

**后端 (`packages/opencode/`):**

| 文件 | 改动 |
|------|------|
| `src/cli/cmd/serve.ts` / `web.ts` | 新增 `--base-path` CLI 选项 |
| `src/server/server.ts` | `basePathHandler`: 路径重写、嵌入式 Web UI 服务、CSP 安全头、fallback proxy |
| `src/util/base-path.ts` | `normalizeBasePath`, `rewriteHtmlForBasePath`, `rewriteJsForBasePath`, `rewriteCssForBasePath`, `generateBasePathScript` |
| `src/project/project.ts` | 非 git 目录使用目录路径 hash 作为 project ID，worktree fallback 为目录本身 |

**前端 (`packages/app/`):**

| 文件 | 改动 |
|------|------|
| `src/pages/layout.tsx` | `currentProject()` 缓存 IIFE，`<Show>` 使用 callback 形式防止 race condition |
| `src/pages/layout/sidebar-items.tsx` | `?.` 可选链保护 `dirs` 和 `name` |
| `src/pages/layout/sidebar-project.tsx` | 所有 `.worktree` 访问添加 `?.` 保护 |
| `src/pages/layout/sidebar-workspace.tsx` | `SortableWorkspace`/`LocalWorkspace` undefined 保护 |

### 6.2 Git Commits (按时间顺序)

```
79696cf feat: add --base-path support for reverse proxy deployments
98ff243 fix: rewrite SDK default client baseUrl for first-load compatibility
38a5aad fix: use CWD as worktree for non-git directories instead of root
3bb4827 fix: resolve first-load worktree crash via multi-layer defense
20bdc2e fix: serve embedded web UI in base-path mode and guard frontend against undefined project
904006d refactor: remove dead joinPath code and add CSP headers to base-path mode
```

### 6.3 已知限制

- **仅 amd64**: Bun 单文件二进制当前只构建 x86_64 版本
- **非 git 目录**: OpenCode 在非 git 目录下功能受限 (无 diff/blame 等 VCS 功能)
- **Regex 重写脆弱性**: `rewriteJsForBasePath` 依赖前端 bundle 中的特定代码模式，上游大版本更新可能需要调整 regex

---

## 7. 复制到新集群的检查清单

### Step 1: NFS 准备
- [ ] 新集群的节点可以访问 NFS 服务器 (或搭建本地 NFS)
- [ ] 复制整个 `.d2vm/` 目录到新 NFS 服务器 (约 740MB)
  ```bash
  rsync -avz --progress root@源NFS:data/nfs/VM/.d2vm/ /data/nfs/VM/.d2vm/
  ```
- [ ] 设置脚本可执行权限: `chmod +x /.d2vm/scripts/*.sh`

### Step 2: K8s 配置
- [ ] 创建 NFS PV/PVC 或在 Pod spec 中直接使用 nfs volume
- [ ] 配置 Pod command 为 `/.d2vm/scripts/base_cmd_test.sh` + 正确的 args
- [ ] 根据需要设置 `ENABLE_*` 环境变量
- [ ] 确保容器端口 (8888, 5099, 8443, 8172, 22) 通过 Service 暴露

### Step 3: Ingress/代理
- [ ] 配置反向代理规则 (参考第 5 节)
- [ ] 确认 WebSocket 支持已启用 (VNC 和 OpenCode **必须**)
- [ ] 确认 OpenCode 路径**不做** strip

### Step 4: 验证
- [ ] 创建测试容器，所有 `ENABLE_*` 设为 true
- [ ] 验证各服务可通过浏览器访问
- [ ] 验证 OpenCode 首次加载无报错
- [ ] 验证 VNC WebSocket 连接正常
- [ ] 验证 Jupyter 密码/Token 认证正常

---

## 8. 故障排查

### OpenCode 白屏/报错
- 检查反向代理是否 strip 了 `/opencode/{JOB_NAME}/` 前缀 → **不应该 strip**
- 检查 WebSocket 连接是否正常 (浏览器 DevTools → Network → WS)
- 检查二进制是否最新: `md5sum /.d2vm/services/opencode/amd64/opencode`

### VNC 连不上
- 检查容器内是否有 X11 桌面环境 (XFCE/GNOME/KDE)
- 检查 WebSocket proxy (websocat 或 websockify) 是否启动: `ps aux | grep websocat`
- 检查 5099 端口是否被防火墙/NetworkPolicy 阻断

### Jupyter 启动失败
- 如果镜像内有 jupyter: 检查 `jupyter_passwd_expect.sh` 是否有 expect 命令
- 如果用 uv/uvx: 首次启动需要下载包，可能较慢 (1-3 分钟)
- 检查 8888 端口冲突

### code-server 无响应
- 检查 `~/.config/code-server/config.yaml` 是否生成
- 检查 8443 端口是否已被占用

---

## 9. 安全注意事项

- 所有服务共享**同一个密码** (通过 `base_cmd_test.sh` 的 `$1` 参数传入)
- OpenCode 使用 HTTP Basic Auth (`OPENCODE_SERVER_PASSWORD`)
- code-server 使用 config.yaml 中的 password
- Jupyter 使用 token 或 password (取决于是预装还是 uvx 启动)
- VNC 使用独立的 VNC password (通过 `vnc_passwd_expect.sh` 设置)
- **建议**: 在 Ingress 层额外添加认证 (如 OAuth2 Proxy) 用于生产环境
