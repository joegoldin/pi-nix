import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetWarmBashParser,
  warmBashParser,
} from "#src/access-intent/bash/parser";
import { type BashCommand, BashProgram } from "#src/access-intent/bash/program";
import { pathFlavorForPlatform } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path/path-normalizer";

const normalizer = new PathNormalizer(
  pathFlavorForPlatform(process.platform),
  "/test/cwd",
);

/** The units the synchronous parse enumerates, or `null` while cold. */
function commandsOf(command: string): BashCommand[] | null {
  return BashProgram.parseSync(command, normalizer)?.commands() ?? null;
}

describe("BashProgram.parseSync commands", () => {
  beforeEach(() => {
    resetWarmBashParser();
  });
  afterEach(() => {
    resetWarmBashParser();
  });

  it("returns null when the parser is not warm", () => {
    expect(commandsOf("echo hi")).toBeNull();
  });

  describe("once warm", () => {
    beforeEach(async () => {
      await warmBashParser();
    });

    it("withholds a wrapped reader's exemption once its argument's HOME is reassigned", () => {
      expect(commandsOf('xargs find "$HOME"')).toEqual([
        {
          text: 'xargs find "$HOME"',
          wrapperKind: "indirection",
          executedUnit: 'find "$HOME"',
          floorExemption: "core-reader",
        },
      ]);
      expect(commandsOf('HOME=-delete; xargs find "$HOME"')).toEqual([
        { text: "HOME=-delete" },
        {
          text: 'xargs find "$HOME"',
          wrapperKind: "indirection",
          executedUnit: 'find "$HOME"',
        },
      ]);
    });

    it("returns a single unit for a lone command", () => {
      expect(commandsOf("echo hi")).toEqual([{ text: "echo hi" }]);
    });

    it("decomposes a chained command into its units", () => {
      expect(commandsOf("cd /repo && npm install x")).toEqual([
        { text: "cd /repo" },
        { text: "npm install x" },
      ]);
    });

    it("descends into a command substitution, tagging its context", () => {
      expect(commandsOf("echo $(rm -rf /)")).toEqual([
        { text: "echo $(rm -rf /)" },
        { text: "rm -rf /", context: "command_substitution" },
      ]);
    });

    it("flags an opaque wrapper", () => {
      expect(commandsOf('bash -c "rm -rf /"')).toEqual([
        {
          text: 'bash -c "rm -rf /"',
          wrapperKind: "opaque-payload",
          executedUnit: "rm -rf /",
          // The path projection reads the payload as a relative path, so its
          // absolute spelling is spelled; the wrapper floor holds either way.
          spellings: ["bash -c /test/cwd/rm -rf "],
        },
      ]);
    });

    it("returns an empty array for a comment-only command", () => {
      expect(commandsOf("# just a comment")).toEqual([]);
    });

    it("returns an empty array for an empty command", () => {
      expect(commandsOf("")).toEqual([]);
    });

    it("enumerates a command a partial parse dropped (#875)", () => {
      // Gate parity (#309): the advisory answer must not be weaker than the
      // gate's, and the gate salvages this command through `BashProgram`.
      expect(
        commandsOf(
          "git add -A . && git commit -F - <<'MSG' 2>&1 | rm -rf /tmp/x\nmsg\nMSG",
        ),
      ).toEqual([
        {
          text: "git add -A .",
          parseUnresolved: true,
          spellings: ["git add -A /test/cwd"],
        },
        { text: "git commit -F", parseUnresolved: true },
        { text: "rm -rf /tmp/x", parseUnresolved: true, salvaged: true },
        { text: "git add -A .", parseUnresolved: true, salvaged: true },
        { text: "git commit -F", parseUnresolved: true, salvaged: true },
        { text: "rm -rf /tmp/x", parseUnresolved: true, salvaged: true },
      ]);
    });

    it("enumerates a command after a heredoc the grammar cannot parse", () => {
      expect(commandsOf("cat <<EOF ; rm -rf /tmp/x\nb\nEOF")).toEqual([
        { text: "cat", parseUnresolved: true },
        { text: "cat", parseUnresolved: true, salvaged: true },
        { text: "rm -rf /tmp/x", parseUnresolved: true, salvaged: true },
      ]);
    });

    describe("a unit opening with a home prefix carries its home spelling", () => {
      it("spells a command named through ~", () => {
        expect(commandsOf("~/bin/x --y")).toEqual([
          { text: "~/bin/x --y", spellings: [`${homedir()}/bin/x --y`] },
        ]);
      });

      it("spells a command named through $HOME", () => {
        expect(commandsOf("$HOME/bin/x")).toEqual([
          { text: "$HOME/bin/x", spellings: [`${homedir()}/bin/x`] },
        ]);
      });

      it("withholds the spelling once the program rebinds HOME", () => {
        expect(commandsOf("HOME=/tmp/evil; ~/bin/x")).toEqual([
          { text: "HOME=/tmp/evil" },
          { text: "~/bin/x" },
        ]);
      });

      it("withholds the spelling under a prefix assignment of HOME", () => {
        expect(commandsOf("HOME=/tmp/evil ~/bin/x")).toEqual([
          { text: "~/bin/x" },
        ]);
      });

      it("does not spell a quoted command name", () => {
        expect(commandsOf('"~/bin/x"')).toEqual([{ text: '"~/bin/x"' }]);
      });

      it("spells a home-prefixed argument as an argument, not as the unit's head", () => {
        expect(commandsOf("echo ~/x")).toEqual([
          { text: "echo ~/x", spellings: [`echo ${homedir()}/x`] },
        ]);
      });

      it("spells a wrapper's home-prefixed argument as an argument", () => {
        const units = commandsOf("sudo ~/bin/x");
        expect(units?.map((unit) => unit.spellings)).toEqual([
          [`sudo ${homedir()}/bin/x`],
        ]);
      });

      it("spells a nested command on its own, not its enclosing one", () => {
        expect(commandsOf("echo $(~/bin/x)")).toEqual([
          { text: "echo $(~/bin/x)" },
          {
            text: "~/bin/x",
            context: "command_substitution",
            spellings: [`${homedir()}/bin/x`],
          },
        ]);
      });
    });
  });
});
