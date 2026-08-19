# Design §12's governing rule as a test: prompt fragments state policy, never
# inventory. A fragment naming a tool, a skill, a model or a path is a fragment
# that goes stale silently, so this fails the build instead.
{
  pkgs,
  ...
}:
let
  inherit (pkgs) lib;

  fragments = {
    untrusted-peer-input = builtins.readFile ../prompt/untrusted-peer-input.md;
  };

  banned = [
    # tool names injected by registerTool
    "intercom"
    "contact_supervisor"
    "TodoWrite"
    "Bash"
    "Read"
    "Grep"
    "Glob"
    # skill names injected per the Agent Skills spec
    "subagent-driven-development"
    "dispatching-parallel-agents"
    "writing-plans"
    "brainstorming"
    "systematic-debugging"
    "test-driven-development"
    # harness and model inventory
    "Claude Code"
    "SendMessage"
    "ListAgents"
    "pi-intercom"
    "pi-subagents"
    "claude-"
    "gpt-"
    # environment inventory
    "/home/"
    "/nix/store"
    "~/.pi"
    "broker.sock"
  ];

  hits = name: text: map (b: "${name}: names \"${b}\"") (lib.filter (b: lib.hasInfix b text) banned);

  allHits = lib.concatLists (lib.mapAttrsToList hits fragments);
in
if allHits != [ ] then
  throw ''
    prompt fragment inventory lint failed (design §12):
      ${lib.concatStringsSep "\n  " allHits}
    Fragments state policy. Tool names come from registerTool, skill names from
    the skills XML block, and paths from the environment. Rewrite the fragment.
  ''
else
  pkgs.runCommand "pi-nix-prompt-fragment-inventory" { } ''
    echo "prompt fragments: ${toString (lib.length (lib.attrNames fragments))} checked, no inventory"
    touch $out
  ''
