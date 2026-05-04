# Contributing to Pilot Console

Thank you for your interest in contributing to Pilot Console! This document provides guidelines and instructions for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `npm install`
4. Create a branch for your changes: `git checkout -b my-feature`

### Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 9
- **Git**
- **GitHub CLI** (`gh`) — required for Copilot CLI sessions
- A C/C++ toolchain for native modules (`node-pty`, `better-sqlite3`):
  - **Windows:** Visual Studio Build Tools
  - **Linux:** `build-essential` and `python3`

### Development

```bash
npm run dev       # Start dev server with HMR
npm test          # Run tests
npm run lint      # Run linter
npm run build     # Production build
```

## How to Contribute

### Reporting Issues

- Use [GitHub Issues](../../issues) to report bugs or suggest features
- Search existing issues before creating a new one
- Include steps to reproduce for bug reports

### Pull Requests

1. Ensure your code passes linting and tests: `npm run lint && npm test`
2. Update documentation if your changes affect user-facing behavior
3. Keep PRs focused — one feature or fix per PR
4. Write clear commit messages

### Coding Guidelines

- Write TypeScript with strict types
- Follow the existing code style (enforced by ESLint)
- Add tests for new functionality

## Legal

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
