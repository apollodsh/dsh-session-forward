# 安装与升级 / Installation and upgrades

## 中文

需要 DSH `>= 0.2.1-rc.2 < 0.3.0`；从 GitHub 安装还需要 Git。

### 首次安装

1. 在 DSH 打开 **插件 → 添加插件**。
2. 输入 `github:apollodsh/dsh-session-forward#v0.2.1`，或者输入已下载的插件 `.tgz` 文件的绝对路径。
3. 点击 **安装**，然后启用插件。如果应用提示重启，按提示重启 DSH。
4. 在插件详情确认版本和「运行中」状态。
5. 打开一条已有会话的 **… → 转发**，确认转发弹窗可以打开；同时检查会话页头的转发按钮。

`v0.2.1` 中侧栏菜单与会话页头的转发箭头均朝上。使用固定标签可避免安装内容随 main 分支变化。

### 升级或重复安装

要从已安装版本升级，在插件页按提示先卸载此第三方插件，再按首次安装步骤安装并启用目标固定版本或对应 `.tgz`。按应用提示重启，然后检查版本和「运行中」状态。

如果安装时提示「这个包已经安装；要安装其他版本，请先卸载它」，先查看详情中的版本和运行状态。目标版本已经安装且运行中时无需重复安装；要换版本则先卸载，再安装目标版本。

### 可选：隔离安装检查

需要 PATH 中有 `dsh`、`node` 和 `mktemp`。脚本使用临时 DSH_HOME 和独立 profile，检查安装包版本、bundle 声明和配置加载，再卸载并重新安装；它不启动模型，也不使用桌面或 Web 的真实 profile。它是 CLI 安装检查，不是桌面界面端到端测试。

```bash
# 默认检查当前目录的插件，预期版本 0.2.1
bash scripts/test-install.sh
# 检查已发布的固定版本，或把地址换成 .tgz 的绝对路径
EXPECTED_VERSION=0.2.0 bash scripts/test-install.sh 'github:apollodsh/dsh-session-forward#v0.2.0'
# 第二个参数可指定升级前的旧插件版本
bash scripts/test-install.sh /absolute/path/to/plugin.tgz 'github:apollodsh/dsh-session-forward#v0.2.0'
```

## English

DSH `>= 0.2.1-rc.2 < 0.3.0` is required. Installing from GitHub also requires Git.

### First installation

1. In DSH, open **Plugins → Add Plugin**.
2. Enter `github:apollodsh/dsh-session-forward#v0.2.1`, or the absolute path to a downloaded plugin `.tgz`.
3. Click **Install** and enable the plugin. Restart DSH if the app prompts you to do so.
4. Check the version and running status in the plugin details.
5. Open **… → Forward** on an existing session and confirm the forwarding dialog opens. Also check the forwarding button in the session header.

Both forwarding arrows point upward in `v0.2.1`. Use the pinned GitHub ref to keep the installation independent of main-branch changes.

### Upgrades and repeated installation

To upgrade an existing installation, follow the plugin page's instructions to uninstall this third-party plugin first. Then install and enable the target pinned version or its `.tgz` using the first-install steps. Restart if prompted, and check the version and running status.

If installation reports that the package is already installed and must be uninstalled to install another version, check the version and running status in its details. If the target version is already installed and running, there is no need to install it again. To change versions, uninstall first and then install the target version.

### Optional isolated installation smoke

The script requires `dsh`, `node`, and `mktemp` on PATH. It uses a temporary DSH_HOME and a separate profile to check the installed version, bundle declaration, and configuration loading, then uninstalls and reinstalls. It does not start a model or use the real desktop or Web profile. This checks CLI installation, not the desktop UI end to end.

```bash
# Default: check the local checkout, expecting version 0.2.1
bash scripts/test-install.sh
# Check the released pinned version, or substitute an absolute .tgz path
EXPECTED_VERSION=0.2.0 bash scripts/test-install.sh 'github:apollodsh/dsh-session-forward#v0.2.0'
# An optional second argument specifies the older plugin version to upgrade from
bash scripts/test-install.sh /absolute/path/to/plugin.tgz 'github:apollodsh/dsh-session-forward#v0.2.0'
```
