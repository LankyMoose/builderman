# %PACKAGE-NAME%

Development monorepo template for **%PACKAGE-NAME%**.

Get started by running

```bash
node setup -p packagename -g mygithubusername -e me@hotmail.com
# OR
node setup --package packagename --github mygithubusername --email me@hotmail.com
```

## Structure

- `.github`
  - Contains workflows used by GitHub Actions.
- `packages`
  - Contains the individual packages managed in the monorepo.
  - [%PACKAGE-NAME%](https://github.com/%GITHUB-USERNAME%/%PACKAGE-NAME%/blob/main/packages/lib)
- `sandbox`
  - Contains example applications and random tidbits.

## Tasks

- Use `make build` to recursively run the build script in each package
- Use `make test` to recursively run the test script in each package
