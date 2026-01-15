# builderman

Development monorepo template for **builderman**.

## Structure

- `.github`
  - Contains workflows used by GitHub Actions.
- `packages`
  - Contains the individual packages managed in the monorepo.
  - [builderman](https://github.com/LankyMoose/builderman/blob/main/packages/lib)
- `sandbox`
  - Contains example applications and random tidbits.

## Tasks

- Use `pnpm build` to recursively run the build script in each package
- Use `pnpm test` to recursively run the test script in each package
