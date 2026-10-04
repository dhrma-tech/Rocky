# Public eval corpus

All files in `corpus/` and `sources/` were written for Rocky and are released under the repository license (Apache-2.0). People, companies and figures in them are fictional.

`corpus/econ-lecture-notes.pdf` is printed from `sources/econ-lecture-notes.html` with Edge headless:

```sh
msedge --headless=new --no-pdf-header-footer --print-to-pdf=evals/public/corpus/econ-lecture-notes.pdf evals/public/sources/econ-lecture-notes.html
```

The plan originally named an OpenStax chapter. As of 2026-10-04 the relevant OpenStax titles are CC BY-NC-SA, which doesn't fit an Apache-2.0 repo, so the chapter was replaced by original notes.

Private eval material (your own lectures, notes and accounts) goes in `evals/private/`, which is gitignored.
