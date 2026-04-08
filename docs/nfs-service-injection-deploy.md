# NFS-Based Service Injection — 部署与复制指南

> 通过 NFS 共享目录 `.d2vm/` 向任意 K8s 容器注入 Jupyter、VNC、code-server、OpenCode Web 等开发服务。
> 无需 sidecar、无需修改容器镜像、无需容器内包管理器。

---

## 1. 架构概览

```
              │ Traefik Ingress
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
              │ Traefik Ingress (path-based routing)
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
| 反向代理 | Traefik Ingress Controller (或兼容的 Ingress Controller)，支持 path-based 路由和 WebSocket |

---

## 3. 准备 NFS 共享目录

所有服务二进制和启动脚本打包在 `d2vm-services` Docker 镜像中，托管在 Harbor：

```
harbor.yuanwuzhi.io/library/d2vm-services:<版本号>
```

> 镜像内容为纯文件（非可运行容器），通过 `crane export` 解压到 NFS 即可使用。

### 3.1 全新部署

首次在新集群搭建时，需要完整部署 `.d2vm/` 目录。提供三种方式，按需选择：

#### 方式一：Ansible Role（推荐，多集群管理）

适合已有 Ansible 基础设施的环境。D2VM-ansible 仓库提供了 `d2vm_services` role，支持在线/离线两种模式。

```bash
# 在线模式 — 从 Harbor 拉取
ansible-playbook -i inventory/hosts playbooks/deploy_d2vm_services.yml \
  -e d2vm_services_version=v1.1

# 离线模式 — 从本地 tar.gz 部署
ansible-playbook -i inventory/hosts playbooks/deploy_d2vm_services.yml \
  -e d2vm_services_mode=offline \
  -e d2vm_services_tar_file=/path/to/d2vm-services-v1.1.tar.gz
```

Role 默认配置见 `roles/d2vm_services/defaults/main.yml`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `d2vm_services_registry` | `harbor.yuanwuzhi.io` | Harbor 地址 |
| `d2vm_services_version` | `v1.0` | 镜像版本标签 |
| `d2vm_services_dest` | `{{ nfs_root }}/VM/.d2vm` | NFS 目标路径 |
| `d2vm_services_mode` | `online` | `online` (crane) 或 `offline` (tar) |
| `d2vm_services_skip_login` | `false` | 跳过 Harbor 登录 |

#### 方式二：部署脚本（轻量，单机快速部署）

不依赖 Ansible，直接在 NFS 服务器上运行一条脚本：

```bash
# 在线 — 从 Harbor 拉取（需要 crane，脚本会自动安装）
bash deploy-d2vm-services.sh --version v1.1 --harbor-user admin

# 离线 — 从 tar.gz 文件
bash deploy-d2vm-services.sh --from-tar /tmp/d2vm-services-v1.1.tar.gz

# 自定义 NFS 路径
bash deploy-d2vm-services.sh --nfs-root /data/nfs/VM --version v1.1 --skip-login
```

脚本自动处理：crane 安装、Harbor 登录、镜像拉取解压、权限设置、文件验证。

> 脚本位于 D2VM-ansible 仓库 `scripts/deploy-d2vm-services.sh`。

#### 方式三：手动部署

适合了解细节或需要逐步调试的场景。

```bash
NFS_ROOT="/data/nfs/VM"

# 1. 安装 crane (如果没有)
curl -sL https://github.com/google/go-containerregistry/releases/download/v0.21.3/go-containerregistry_Linux_x86_64.tar.gz \
  | tar xz -C /tmp/ crane

# 2. 登录 Harbor (如果需要)
/tmp/crane auth login harbor.yuanwuzhi.io -u admin

# 3. 拉取镜像并解压
tmpdir=$(mktemp -d)
/tmp/crane export harbor.yuanwuzhi.io/library/d2vm-services:v1.1 - | tar xf - -C "$tmpdir"

# 4. 同步到 NFS
mkdir -p ${NFS_ROOT}/.d2vm
rsync -a "$tmpdir/.d2vm/" ${NFS_ROOT}/.d2vm/
rm -rf "$tmpdir"

# 5. 设置权限
chmod +x ${NFS_ROOT}/.d2vm/scripts/*.sh
chmod +x ${NFS_ROOT}/.d2vm/services/opencode/amd64/opencode
chmod +x ${NFS_ROOT}/.d2vm/services/code-server/amd64/bin/code-server
chmod +x ${NFS_ROOT}/.d2vm/services/TigerVNC/amd64/usr/bin/Xvnc
chmod +x ${NFS_ROOT}/.d2vm/services/websocat/amd64/websocat
chmod +x ${NFS_ROOT}/.d2vm/services/uv/amd64/uv
```

#### 构建 OpenCode（仅开发者需要）

日常部署**不需要**手动构建 OpenCode —— 镜像中已包含构建好的二进制。

仅在需要修改 OpenCode fork 代码后重新构建时使用：

```bash
# 1. 克隆 fork
git clone -b feature/base-path-support https://github.com/yuanwuzhi/opencode.git /tmp/opencode-fork

# 2. 安装依赖 (需要 Bun >= 1.1)
cd /tmp/opencode-fork && bun install

# 3. 缓存 models.dev API JSON (构建时需要，直接 fetch 可能不稳定)
curl -o /tmp/models-api.json https://models.dev/api.json

# 4. 构建单文件二进制 (含内嵌 Web UI)
cd packages/opencode
MODELS_DEV_API_JSON=/tmp/models-api.json bun run script/build.ts --single --skip-install
# 注意: 不要加 --skip-embed-web-ui，前端必须打包进二进制

# 5. 部署到 NFS (替换镜像中的版本)
cp dist/opencode-linux-x64/bin/opencode ${NFS_ROOT}/.d2vm/services/opencode/amd64/opencode
chmod +x ${NFS_ROOT}/.d2vm/services/opencode/amd64/opencode
```

> **注意**: 当前 OpenCode 仅支持 x86_64 (amd64)。arm64 架构会被启动脚本跳过。

### 3.2 版本升级

已有 `.d2vm/` 目录的环境从 v1.x 升到新版本，有两种方式：

#### 整体覆盖升级（推荐）

用新版本镜像整体覆盖，最简单可靠：

```bash
# 脚本方式 (一条命令)
bash deploy-d2vm-services.sh --version v1.1 --skip-login

# 或手动 crane
tmpdir=$(mktemp -d)
/tmp/crane export harbor.yuanwuzhi.io/library/d2vm-services:v1.1 - | tar xf - -C "$tmpdir"
rsync -a "$tmpdir/.d2vm/" /data/nfs/VM/.d2vm/
rm -rf "$tmpdir"
chmod +x /data/nfs/VM/.d2vm/scripts/*.sh
```

#### 最小化升级（仅替换变更文件）

如果清楚版本间的差异，可以只替换变更的文件。参考下方版本变更日志确定需要替换哪些文件。

例如 v1.0 → v1.1 仅 OpenCode 二进制有变化：

```bash
# 直接 scp 替换单个文件
scp opencode root@<NFS_SERVER>:/data/nfs/VM/.d2vm/services/opencode/amd64/opencode
ssh root@<NFS_SERVER> "chmod +x /data/nfs/VM/.d2vm/services/opencode/amd64/opencode"
```

> ⚠️ 升级后需要**新开容器**才能生效。已运行的容器使用的是启动时加载的旧版本。

### 3.3 导出 NFS 共享

首次部署时需要配置 NFS 导出：

```bash
# /etc/exports 添加:
/data/nfs/VM  *(rw,sync,no_subtree_check,no_root_squash)

# 生效
exportfs -ra
systemctl restart nfs-server
```

### 3.4 目录结构参考

```
.d2vm/
├── scripts/
│   ├── base_cmd_test.sh          # 容器入口点
│   ├── set_password.sh           # Jupyter/VNC 启动
│   ├── jupyter_passwd_expect.sh
│   └── vnc_passwd_expect.sh
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

## 5. 反向代理 / Ingress 配置 (Traefik)

所有服务通过 path-based 路由暴露，URL 格式固定为 `/{service}/{JOB_NAME}/`。
平台后端为每个 Job 动态创建对应的 Ingress + Middleware 资源。

以下示例基于实际运行的 Traefik Ingress Controller 配置。`{JOB_NAME}` 为 Job 哈希 ID (如 `fecca7a7`)。

### 5.1 Jupyter — 无 stripPrefix (base_url 内部处理)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: jupyter-{JOB_NAME}
  namespace: haios
  annotations:
    kubernetes.io/ingress.class: traefik
spec:
  ingressClassName: traefik
  rules:
  - http:
      paths:
      - path: /jupyter/{JOB_NAME}/
        pathType: Prefix
        backend:
          service:
            name: job-ports-{JOB_NAME}
            port:
              number: 8888
```

> Jupyter 通过 `--ServerApp.base_url=/jupyter/{JOB_NAME}/` 启动参数内部处理路径前缀，**不需要 stripPrefix**。

### 5.2 VNC (noVNC) — 需要 stripPrefix

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vnc-{JOB_NAME}
  namespace: haios
  annotations:
    kubernetes.io/ingress.class: traefik
    traefik.ingress.kubernetes.io/router.middlewares: haios-vnc-strip-{JOB_NAME}@kubernetescrd
spec:
  ingressClassName: traefik
  rules:
  - http:
      paths:
      - path: /vnc/{JOB_NAME}/
        pathType: Prefix
        backend:
          service:
            name: job-ports-{JOB_NAME}
            port:
              number: 5099
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: vnc-strip-{JOB_NAME}
  namespace: haios
spec:
  stripPrefix:
    prefixes:
    - /vnc/{JOB_NAME}
```

> noVNC 默认在 `/` 下提供服务，无法配置 base path，因此需要 Traefik `stripPrefix` 中间件。
> WebSocket 连接是 VNC 的核心传输方式，**必须确保 Traefik 正确代理 WebSocket**。

### 5.3 code-server — 需要 stripPrefix

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: code-server-{JOB_NAME}
  namespace: haios
  annotations:
    kubernetes.io/ingress.class: traefik
    traefik.ingress.kubernetes.io/router.middlewares: haios-code-server-strip-{JOB_NAME}@kubernetescrd
spec:
  ingressClassName: traefik
  rules:
  - http:
      paths:
      - path: /code-server/{JOB_NAME}/
        pathType: Prefix
        backend:
          service:
            name: job-ports-{JOB_NAME}
            port:
              number: 8443
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: code-server-strip-{JOB_NAME}
  namespace: haios
spec:
  stripPrefix:
    prefixes:
    - /code-server/{JOB_NAME}
```

> code-server 期望在 `/` 路径下运行，不支持原生 base path 配置，需要 `stripPrefix`。

### 5.4 OpenCode Web — 无 stripPrefix (--base-path 内部处理)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: opencode-{JOB_NAME}
  namespace: haios
  annotations:
    kubernetes.io/ingress.class: traefik
spec:
  ingressClassName: traefik
  rules:
  - http:
      paths:
      - path: /opencode/{JOB_NAME}/
        pathType: Prefix
        backend:
          service:
            name: job-ports-{JOB_NAME}
            port:
              number: 8172
```

> ⚠️ **OpenCode 绝不能使用 stripPrefix**。`--base-path /opencode/{JOB_NAME}/` 启动参数让 OpenCode
> 在内部完整处理路径前缀（包括 API 路由、静态资源、SSE 连接）。添加 stripPrefix 会导致 API 路由断裂。

### 5.5 每个 Job 的 Service (参考)

平台后端为每个 Job 自动创建 `NodePort` 类型的 Service，聚合所有服务端口：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: job-ports-{JOB_NAME}
  namespace: haios
spec:
  type: NodePort
  selector:
    job-name: {JOB_NAME}     # 根据实际标签调整
  ports:
  - name: ssh
    port: 22
    targetPort: 22
  - name: jupyter
    port: 8888
    targetPort: 8888
  - name: vnc
    port: 5099
    targetPort: 5099
  - name: code-server
    port: 8443
    targetPort: 8443
  - name: opencode
    port: 8172
    targetPort: 8172
```

### 5.6 总结对照表

| 服务 | stripPrefix | WebSocket | 原因 | 认证方式 |
|------|:-----------:|:---------:|------|----------|
| Jupyter | ❌ 不 strip | ✅ 需要 | `--base_url` 内部处理前缀 | Token / Password |
| VNC (noVNC) | ✅ **需要** | ✅ **必须** | noVNC 不支持 base path | VNC Password |
| code-server | ✅ **需要** | ✅ 需要 | code-server 不支持原生 base path | Password (config.yaml) |
| OpenCode | ❌ **绝不 strip** | ✅ **必须** (SSE) | `--base-path` 内部处理前缀 | HTTP Basic Auth |

> **Traefik 默认支持 WebSocket 代理**，无需额外配置。
> 
> `stripPrefix` Middleware 的引用格式为 `{namespace}-{middleware-name}@kubernetescrd`，
> 例如 `haios-vnc-strip-fecca7a7@kubernetescrd`。

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

**v1.0 — 初始 base-path 支持:**

```
79696cf feat: add --base-path support for reverse proxy deployments
98ff243 fix: rewrite SDK default client baseUrl for first-load compatibility
38a5aad fix: use CWD as worktree for non-git directories instead of root
3bb4827 fix: resolve first-load worktree crash via multi-layer defense
20bdc2e fix: serve embedded web UI in base-path mode and guard frontend against undefined project
904006d refactor: remove dead joinPath code and add CSP headers to base-path mode
```

**v1.1 — CSP 根因修复 + 稳定性:**

```
7c47703 fix: guard against non-array API responses in session/provider loading
323c6c7 fix: comprehensive safeArray guard for all SDK API responses
07a9f0e fix: guard session.time access with optional chaining
6150c43 fix: resolve CSP hash mismatch, provider retry, and worktree guard for base-path mode
```

### 6.3 版本变更日志

#### d2vm-services v1.1 (相对于 v1.0)

**变更范围**: 仅 OpenCode 二进制更新，其他服务 (code-server, TigerVNC, noVNC 等) 无变化。

**升级方式**: 替换 `services/opencode/amd64/opencode` 即可（参考 3.2 节最小化升级）。

| 修复项 | 说明 |
|--------|------|
| **CSP SHA-256 hash 不匹配** | `generateBasePathScript()` 生成的 inline script 带有前导换行符，旧版 hash 计算忽略了这个换行，导致浏览器 CSP 静默拦截 `__OPENCODE_BASE_PATH__` 脚本。改为解析最终 HTML 中所有 inline script 内容计算 hash。**这是 v1.0 中首次加载白屏/功能异常的根因**。 |
| **Provider 列表为空** | `retry()` 默认只重试网络错误，自定义 "Empty provider list" 异常不会触发重试。改为 `retryIf: () => true` 重试所有错误。 |
| **worktree 空指针崩溃** | 非 git 目录下 `worktree` 可能为 undefined，`.replace()` / `.filter()` 调用崩溃。添加 `?.` 可选链保护。 |
| **时间戳显示 "56年前"** | `session.time` 可能为 undefined，`formatDistanceToNow(undefined)` 返回 1970 年距今的时间差。添加 `?.` 保护和 fallback。 |

### 6.4 已知限制

- **仅 amd64**: Bun 单文件二进制当前只构建 x86_64 版本
- **非 git 目录**: OpenCode 在非 git 目录下功能受限 (无 diff/blame 等 VCS 功能)
- **Regex 重写脆弱性**: `rewriteJsForBasePath` 依赖前端 bundle 中的特定代码模式，上游大版本更新可能需要调整 regex

---

## 7. 复制到新集群的检查清单

### Step 1: NFS 准备

**方式 A — Ansible (推荐):**
- [ ] 在 D2VM-ansible 的 inventory 中添加新集群的 NFS 节点
- [ ] 运行部署:
  ```bash
  ansible-playbook -i inventory/hosts-<新集群> playbooks/deploy_d2vm_services.yml \
    -e d2vm_services_version=v1.1
  ```

**方式 B — 脚本:**
- [ ] 将 `scripts/deploy-d2vm-services.sh` 复制到新集群的 NFS 服务器
- [ ] 运行: `bash deploy-d2vm-services.sh --version v1.1 --harbor-user admin`

**方式 C — rsync 从现有集群复制:**
- [ ] 直接从已部署的 NFS 服务器同步 (约 740MB):
  ```bash
  rsync -avz --progress root@源NFS:/data/nfs/VM/.d2vm/ /data/nfs/VM/.d2vm/
  chmod +x /data/nfs/VM/.d2vm/scripts/*.sh
  ```

**通用:**
- [ ] 配置 NFS 导出 (`/etc/exports`) 并重启 nfs-server
- [ ] 确认 K8s 节点可挂载 NFS

### Step 2: K8s 配置
- [ ] 创建 NFS PV/PVC 或在 Pod spec 中直接使用 nfs volume
- [ ] 配置 Pod command 为 `/.d2vm/scripts/base_cmd_test.sh` + 正确的 args
- [ ] 根据需要设置 `ENABLE_*` 环境变量
- [ ] 确保容器端口 (8888, 5099, 8443, 8172, 22) 通过 Service 暴露

### Step 3: Traefik Ingress
- [ ] 确保集群安装了 Traefik Ingress Controller 并支持 `traefik.io/v1alpha1` CRD
- [ ] 为每个 Job 创建 4 个 Ingress 资源 (jupyter / vnc / code-server / opencode)，参考第 5 节
- [ ] 为 VNC 和 code-server 创建对应的 `stripPrefix` Middleware
- [ ] 确认 OpenCode 和 Jupyter 的 Ingress **没有** stripPrefix middleware
- [ ] 确认 WebSocket 代理正常 (Traefik 默认支持，无需额外配置)

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
