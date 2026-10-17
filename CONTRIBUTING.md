# Contributing

Thanks for helping. This file lists the rules a pull request must follow.

## Run the tests

```sh
npm ci
npm test
```

`npm test` builds the package with `tsc` and then runs every test file. The build is the type
check, so a type error fails the tests. Do not run `node --test test/` directly: it skips the
build and tests a stale `dist/`.

## Runtime floor

The floor is Node.js 20 (`engines` in `package.json`). CI runs the tests on Node 20 and Node 24.
Do not use an API that Node 20 does not have. The package has no runtime dependencies. Keep it
that way.

## Test fixtures

- `test/merchant-api-contract.json` is the shared response contract. Every Dominaite SDK carries
  the same bytes. Do not edit it in a pull request here. It changes only after the API changes.
- `test/merchant-api-wire-contract.json` is generated from the live production contract by
  `.github/workflows/contract-drift.yml`. Do not edit it by hand. When the drift check fails,
  the API moved: update the SDK first, then regenerate the fixture with the jq projection in
  that workflow.
- When a fixture test fails, fix the SDK, not the fixture.

## Tests with every change

Every change needs a test. Test what a caller gets back, not how the code works inside. A bug
fix needs a test that fails on the old code.

## Versions

The SDK is 0.x on purpose. A minor release (0.6 to 0.7) can contain a breaking change. A
breaking change goes in `CHANGELOG.md` under the next unreleased minor version. Do not change
the version in `package.json` in a pull request.

## Releases

The maintainer tags releases. A pull request never creates a tag, a GitHub release or an npm
package.

## Security

Do not report a security problem in a public issue or pull request. See
[SECURITY.md](SECURITY.md).
