{ pkgs, ... }:
pkgs.runCommand "pi-openai-models-tests" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  node ${./openai-models.mjs} ${../ai}
  touch $out
''
