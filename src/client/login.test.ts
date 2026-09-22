// The Login panel's two halves: finding the URL `/login` printed across rows, and the code's bytes.
// The rows below are what a 60-column pane actually showed for `/login` in Claude Code.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { codeBytes, keptUrl, loginUrl } from "./login.ts";

const URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ep6XleOSvoieJYD&code_challenge_method=S256&state=1r8WIfut-sNJJ6UxGFXf";

/** The URL cut into rows of `cols`, the way the pane draws it, between the screen's own prose. */
const screen = (url: string, cols: number, indent = ""): string[] => {
  const rows: string[] = [];
  let rest = url;
  const lead = indent;
  while (rest !== "") {
    const room = cols - lead.length;
    rows.push(lead + rest.slice(0, room));
    rest = rest.slice(room);
  }
  return [
    "   Login",
    "",
    "   Browser didn't open? Use the url below to   (c to",
    "   sign in                                     copy)",
    "",
    ...rows,
    "",
    "   Paste code here if prompted >",
    "",
    "   Esc to cancel",
  ];
};

void describe("the login URL", () => {
  void test("is rejoined whole from the rows the pane split it across", () => {
    assert.equal(loginUrl(screen(URL, 60), 60), URL);
  });

  void test("is rejoined when the rows are indented", () => {
    assert.equal(loginUrl(screen(URL, 60, "   "), 60), URL);
  });

  void test("does not take in the prose after a URL that exactly fills its last row", () => {
    const exact = URL.slice(0, 240);
    const rows = screen(exact, 60).filter(
      (row, i, all) => !(row === "" && all[i - 1] === exact.slice(180)),
    );
    rows.splice(rows.indexOf(exact.slice(180)) + 1, 0, "   Hold Shift while selecting");
    assert.equal(loginUrl(rows, 60), exact);
  });

  void test("is the newest one when an earlier attempt is still in scrollback", () => {
    const older = URL.replace("state=1r8", "state=OLD");
    assert.equal(loginUrl([...screen(older, 60), ...screen(URL, 60)], 60), URL);
  });

  void test("is refused on a host that is not Claude's, however the path is shaped", () => {
    const lookalike = URL.replace("claude.com", "claude.com.evil.example");
    assert.equal(loginUrl(screen(lookalike, 60), 60), undefined);
  });

  void test("is absent when nothing on the pane is a login", () => {
    assert.equal(loginUrl(["see https://example.com/docs", "$ ls"], 60), undefined);
  });
});

void describe("the URL the panel keeps", () => {
  void test("survives a re-read that finds nothing, as a repaint mid-clear does", () => {
    assert.equal(keptUrl(URL, undefined), URL);
  });

  void test("moves to a newer attempt's URL", () => {
    const newer = URL.replace("state=1r8", "state=NEW");
    assert.equal(keptUrl(URL, newer), newer);
  });
});

void describe("the code's bytes", () => {
  void test("submit the code with a carriage return", () => {
    assert.equal(codeBytes("abc#def"), "abc#def\r");
  });

  void test("drop the newline and spaces a phone's paste brings", () => {
    assert.equal(codeBytes("  abc#def\n"), "abc#def\r");
    assert.equal(codeBytes("abc\n#def"), "abc#def\r");
  });

  void test("are nothing for an empty paste", () => {
    assert.equal(codeBytes(" \n"), "");
  });
});
