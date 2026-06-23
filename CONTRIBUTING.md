# Contributing to Browsertrix Crawler (Transparency Hub Fork)

Thank you for your interest in contributing to this fork of Browsertrix Crawler!

## About This Fork

This is a fork of [webrecorder/browsertrix-crawler](https://github.com/webrecorder/browsertrix-crawler) maintained by the Berkman Klein Center for Internet & Society at Harvard University. 

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue with:
- A clear description of the problem
- Steps to reproduce the issue
- Expected vs actual behavior
- Your environment (OS, Node version, etc.)

### Suggesting Enhancements

We welcome suggestions! Please open an issue describing:
- The enhancement you'd like to see
- Why it would be useful
- Any implementation ideas you have

### Pull Requests

1. Fork the repository
2. Create a new branch (`git checkout -b feature/your-feature-name`)
3. Make your changes
4. Add or update tests as needed
5. Run the test suite: `yarn test`
6. Run linting: `yarn lint`
7. Commit your changes with clear commit messages
8. Push to your fork
9. Open a Pull Request

### Development Setup

```bash
# Clone the repository
git clone https://github.com/berkmancenter/browsertrix-crawler-thub-fork.git
cd browsertrix-crawler-thub-fork

# Install dependencies
yarn install

# Run tests
yarn test

# Run linting
yarn lint

# Format code
yarn format:fix
```

### Code Style

- Follow the existing code style
- Use TypeScript for new code
- Run `yarn format:fix` before committing
- Ensure `yarn lint` passes

### Testing

- Add tests for new features
- Ensure all tests pass before submitting a PR
- Tests are located in the `tests/` directory

### Commit Messages

- Use clear, descriptive commit messages
- Reference issue numbers when applicable
- Follow conventional commit format when possible

## Upstream Contributions

If your contribution would benefit the upstream project, consider submitting it to [webrecorder/browsertrix-crawler](https://github.com/webrecorder/browsertrix-crawler) as well.

## License

By contributing, you agree that your contributions will be licensed under the AGPLv3 license.

## Questions?

If you have questions about contributing, feel free to open an issue for discussion.
