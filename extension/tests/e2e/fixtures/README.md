# Form fixtures

ARCHITECTURE.md §10:

> **Fixture-based integration** — save real application form HTML into
> `tests/e2e/fixtures/`, load in jsdom, assert the mapping output. This is the
> regression suite. **Every bug found in the wild becomes a fixture.**

## Capturing a fixture

1. Open the application form.
2. In DevTools, `copy(document.querySelector('form').outerHTML)`.
3. Save it here as `<ats>-<what-makes-it-interesting>.html`.
4. Strip anything identifying — CSRF tokens, tenant ids, prefilled values,
   recruiter names. Fixtures are committed; nothing personal goes in them.

Fixtures are **body fragments**, not whole documents: the test assigns them to
`document.body.innerHTML`. Scripts and stylesheets are not needed and should be
removed — these tests assert the mapping output, not the site's rendering.

## Adding a regression

When a field maps wrongly in the wild, add (or extend) a fixture that reproduces
it and assert the correct key in `../mapping.test.ts` **before** touching the
rule table. That is what stops the same misfire coming back.
