# create-zmp-app

**English** | [Tiếng Việt](./README.vi.md)

Create, extend, verify, and deploy Zalo Mini Apps with Codex or Claude Code.

`create-zmp-app` turns a natural-language brief plus a Mini App ID into a working project that
can be developed further. The agent selects a verified starter or template, binds the App ID,
installs dependencies, builds the project, verifies the UI in a browser, and opens a preview. On
request, it can also run supported Zalo API flows in a simulator or deploy a verified build to
Development or Testing.

## Features

- Create a Mini App from an English or Vietnamese prompt, with or without Vietnamese diacritics.
- Continue an existing project without scaffolding over user-edited code.
- Integrate supported features using current public Zalo Mini App documentation.
- Build and render-check the app at multiple viewport sizes with evidence and diagnostics.
- Run supported flows in a simulator before UAT in the real Zalo client.
- Deploy to Development or Testing only after an explicit request and a successful verification.

## Installation

### Claude Code

```text
/plugin marketplace add dungnn1991/zalo-miniapp-skill
/plugin install create-zmp-app@zalo-miniapp-skill
```

Update later with `/plugin update create-zmp-app`.

### Codex

```bash
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash
```

Requirements: Node.js 20 or newer and Google Chrome. `zmp-cli` is needed only for deployment.
See the [installation and integration guide](./skill/create-zmp-app/HUONG-DAN-TICH-HOP.md) for
installing on both hosts, pinning a version, or using the staging channel.

## Quick start

Open Codex or Claude Code in the directory where you want the app, then ask:

```text
Create a Zalo Mini App clothing store with appId=2607885...
```

The agent runs the pipeline and opens a preview after verification succeeds. Get the Mini App ID
from [Zalo Mini App Developers](https://miniapp.zaloplatforms.com/developers). If the prompt does
not contain an ID, or it conflicts with the current project, the agent stops before changing source
files and asks which ID to use.

Common requests:

| Goal | Example prompt |
|---|---|
| Create a new app | `Create a Zalo Mini App clothing store with appId=...` |
| Use a supported template | `Create a fashion app using zaui-fashion, appId=...` |
| Extend an existing app | `Add Zalo login to the Account button` |
| Try a supported flow | `Run the simulator so I can test the permission flow` |
| Deploy to Development | `Deploy the Development build` |
| Deploy to Testing | `Deploy to Testing with description "sprint 3 test build"` |
| Diagnose a problem | `The app shows Network Error; diagnose it` |

## Templates

The official [ZaUI Templates](https://miniapp.zaloplatforms.com/zaui-templates) catalog currently
lists nine templates. The skill scaffolds only revisions that have passed its own release gates so
installation, build, and rendering are reproducible. In v0.3.2, the release-supported official
template is `zaui-fashion`; requests without a qualified template use the neutral starter for
further development.

See [Official templates](./skill/create-zmp-app/references/official-templates.md) for catalog,
revision, and support-policy details.

## Quality and safety

- The Mini App ID is preserved exactly and checked from source through the build process.
- Safe reruns protect user-edited code; overwriting always requires an explicit choice.
- Simulator output is labeled `SIMULATOR`; mock results are never reported as real Zalo UAT.
- Deployment never starts automatically after a build, and login tokens are never read into logs
  or evidence.
- Every run records verification results, screenshots, and findings for later inspection.

## Documentation

| Topic | Link |
|---|---|
| Installation, versions, and invocation | [Integration guide](./skill/create-zmp-app/HUONG-DAN-TICH-HOP.md) |
| Agent workflow and guardrails | [SKILL.md](./skill/create-zmp-app/SKILL.md) |
| Zalo feature integration | [Feature recipes](./skill/create-zmp-app/references/feature-recipes.md) |
| Official templates | [Official templates](./skill/create-zmp-app/references/official-templates.md) |
| Simulator | [Simulator workflow](./skill/create-zmp-app/references/simulator-workflow.md) |
| Development/Testing deployment | [Deploy workflow](./skill/create-zmp-app/references/deploy-workflow.md) |
| Build, runtime, and CORS troubleshooting | [Troubleshooting](./skill/create-zmp-app/references/troubleshooting.md) |
| Permissions and environment operations | [Operations](./skill/create-zmp-app/references/operations.md) |
| Version history | [Changelog](./skill/create-zmp-app/CHANGELOG.md) |

## Skill development

This repository contains the skill runtime and its verification lab. The release gate currently
runs a 32-case suite plus metadata validation:

```bash
npm test
```

Read [LAB.md](./LAB.md) before changing the contract or pipeline. Changes go through `staging` and
are merged into `main` and tagged only after the release gate passes.

## Official resources

- [Zalo Mini App Documentation](https://docs.zaloplatforms.com/docs/MA)
- [Zalo Mini App Center](https://miniapp.zaloplatforms.com/)
