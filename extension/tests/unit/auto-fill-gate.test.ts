import { beforeEach, describe, expect, it } from 'vitest';
import { looksLikeIdentityForm } from '../../entrypoints/content';
import { scanRoot } from '@/core/scanner';

/**
 * The gate that decides whether to fill a page *unasked*.
 *
 * The content script runs on every site now, so this is the whole defence
 * against an overlay appearing over a login box, a search bar or a checkout.
 * Clicking the toolbar button bypasses it entirely — an explicit request needs
 * no heuristic.
 */

const scan = (html: string) => {
  document.body.innerHTML = html;
  return scanRoot(document).fields;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('does not fill unasked', () => {
  it('on a login form', () => {
    expect(
      looksLikeIdentityForm(
        scan(`
          <form>
            <label for="e">Email</label><input id="e" type="email" />
            <label for="p">Password</label><input id="p" type="password" />
            <button>Sign in</button>
          </form>`),
      ),
    ).toBe(false);
  });

  it('on a search box', () => {
    expect(
      looksLikeIdentityForm(
        scan(`<form><label for="q">Search</label><input id="q" /></form>`),
      ),
    ).toBe(false);
  });

  it('on a newsletter signup', () => {
    expect(
      looksLikeIdentityForm(
        scan(`
          <form>
            <label for="e">Email address</label><input id="e" type="email" />
            <button>Subscribe</button>
          </form>`),
      ),
    ).toBe(false);
  });

  it('on a page whose fields resolve to nothing personal', () => {
    expect(
      looksLikeIdentityForm(
        scan(`
          <form>
            <label for="a">Quantity</label><input id="a" />
            <label for="b">Colour</label><input id="b" />
            <label for="c">Gift message</label><input id="c" />
          </form>`),
      ),
    ).toBe(false);
  });

  it('on a card payment form — several fields, no identity signal', () => {
    // "Name on card" deliberately does not count: it is not the applicant
    // identity signal we are looking for, and filling a checkout unasked is
    // exactly the behaviour that would make this extension untrustworthy.
    expect(
      looksLikeIdentityForm(
        scan(`
          <form>
            <label for="n">Card number</label><input id="n" />
            <label for="x">Expiry</label><input id="x" />
            <label for="c">CVC</label><input id="c" />
          </form>`),
      ),
    ).toBe(false);
  });
});

describe('fills unasked', () => {
  it('on a job application form', () => {
    expect(
      looksLikeIdentityForm(
        scan(`
          <form>
            <label for="f">First Name</label><input id="f" />
            <label for="l">Last Name</label><input id="l" />
            <label for="e">Email</label><input id="e" type="email" />
            <label for="p">Phone</label><input id="p" type="tel" />
            <label for="r">Resume</label><input id="r" type="file" />
          </form>`),
      ),
    ).toBe(true);
  });

  it('on a generic form whose labels are split by a required asterisk', () => {
    expect(
      looksLikeIdentityForm(
        scan(`
          <form class="application-form">
            <div><span>First Name<em>*</em></span><input /></div>
            <div><span>Email Address<em>*</em></span><input /></div>
            <div><span>Mobile Number<em>*</em></span><input /></div>
            <div><span>Current Company</span><input /></div>
          </form>`),
      ),
    ).toBe(true);
  });

  it('on a registration form', () => {
    expect(
      looksLikeIdentityForm(
        scan(`
          <form>
            <label for="f">Full name</label><input id="f" />
            <label for="e">Email</label><input id="e" type="email" />
            <label for="p">Phone number</label><input id="p" />
            <label for="c">City</label><input id="c" />
          </form>`),
      ),
    ).toBe(true);
  });
});
