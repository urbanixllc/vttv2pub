# VesTally Anchor my code

Puts every release on the VesTally public record on BNB Chain: the commit, plus the SHA-256 of
each release file. That gives your project a tamper-evident release history, and lets users check
a download by dropping it into vestallytoken.io/check. It's free, with no sign-up and no API key.

```yaml
# .github/workflows/anchor.yml
on:
  release:
    types: [published]
permissions:
  contents: read
  id-token: write
jobs:
  anchor:
    runs-on: ubuntu-latest
    steps:
      - uses: urbanixllc/vttv2pub/anchor-action@v1
```

To seal build outputs as well, check out the code and build it first, then pass the files:

```yaml
      - uses: urbanixllc/vttv2pub/anchor-action@v1
        with:
          files: |
            dist/*.zip
            dist/SHA256SUMS
```

## What's sent

- **The commit ID and the files' SHA-256 codes.** Files never leave the runner.
- **GitHub's identity token for the run.** The token proves which repository and commit the run is
  for. VesTally checks it against GitHub's published keys, only accepts the commit the run is for,
  and uses the repository only in memory, to apply a daily limit of 200 codes per repository. It
  isn't stored.

## Checking

- **A file:** drop a downloaded file into the check page. A file that was released shows "On the
  public record since *date*", with the date read from BNB Chain itself.
- **A commit:** open `vestallytoken.io/code?commit=<id>`. The code is
  `sha256("git-commit:" + commit ID)`, so you can work it out yourself.
