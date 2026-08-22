# pi.nix

<p align="center">
  <a href="https://lukasl-dev.github.io/pi.nix/">
    <img src="https://img.shields.io/badge/docs-options-5277C3?style=for-the-badge&logo=nixos&logoColor=white" alt="Options">
  </a>
  <a href="https://app.cachix.org/cache/pi">
    <img src="https://img.shields.io/badge/cache-Cachix-5277C3?style=for-the-badge&logo=nixos&logoColor=white" alt="Cachix cache">
  </a>
</p>

A Nix flake for [pi](https://github.com/earendil-works/pi), the terminal coding agent.

It provides:

- packages for `nix run` / `nix build`
- a default npm-built package and an optional Bun-built variant
- NixOS and Home Manager modules
- an overlay exposing `pkgs.pi-coding-agent` and `pkgs.pi-coding-agent-bun`
- `lib.mkCodingAgent` for building a configured wrapper

> [!IMPORTANT]
> This is not the official Nix flake for pi (there isn't one). See [earendil-works/pi#2310](https://github.com/earendil-works/pi/issues/2310) for context.

## Quick start

```bash
nix run github:lukasl-dev/pi.nix --accept-flake-config
```

Or build it locally:

```bash
nix build .#coding-agent --accept-flake-config
```

To build the Bun-based variant instead:

```bash
nix build .#coding-agent-bun --accept-flake-config
```

## Usage

```nix
{
  inputs.pi.url = "github:lukasl-dev/pi.nix";
}
```

### Binary cache

Build results are pushed to [pi.cachix.org](https://pi.cachix.org), and the Bun toolchain is fetched through the nix-community cache used by `bun2nix`. The flake declares both substituters and public keys via `nixConfig`, so consumers can use `--accept-flake-config` or configure them explicitly:

```nix
nix.settings = {
  extra-substituters = [
    "https://pi.cachix.org"
    "https://nix-community.cachix.org"
  ];
  extra-trusted-public-keys = [
    "pi.cachix.org-1:lGeoGJaZ5ZDabuRzkcD5EBTNnDM4HJ1vqeOxlWk1Flk="
    "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
  ];
};
```

### NixOS

```nix
{ inputs, config, ... }:
{
  imports = [ inputs.pi.nixosModules.default ];

  programs.pi.coding-agent = {
    enable = true;
    # rules = ''Be concise.'';
    # skills = [ ./skills/my-skill ];
    # extensions = [ ./extensions/my-extension.ts ];
    # themes = [ ./themes/catppuccin-mocha.json ];
    # promptTemplates = [ ./prompts ];
    # models = ./models.json;
    # settings = {
    #   model = "gpt-5";
    # };
    # jail.enable = true;
    # extraArgs = [ "--provider" "openai" "--model" "gpt-5" ];
    # environment.PI_CODING_AGENT_DIR.value = "/path/to/pi-agent";
    # environment.OPENAI_API_KEY.file = config.sops.secrets.openai-api-key.path;
  };
}
```

### Home Manager

```nix
{ inputs, config, ... }:
{
  imports = [ inputs.pi.homeModules.default ];

  programs.pi.coding-agent = {
    enable = true;
    # rules = ''Be concise.'';
    # skills = [ ./skills/my-skill ];
    # models = ./models.json;
    # settings.model = "gpt-5";
    # environment.PI_CODING_AGENT_DIR.value = "${config.home.homeDirectory}/.pi/agent";
    # environment.OPENAI_API_KEY.file = config.sops.secrets.openai-api-key.path;
  };
}
```

### Overlay

```nix
{ inputs, pkgs, ... }:
{
  nixpkgs.overlays = [ inputs.pi.overlays.default ];
  environment.systemPackages = [
    pkgs.pi-coding-agent
    # or pkgs.pi-coding-agent-bun
  ];
}
```

### Custom package

```nix
{ inputs, pkgs, ... }:
let
  pi = inputs.pi.lib.mkCodingAgent {
    inherit pkgs;
    modules = [{
      pi.coding-agent = {
        rules = ''Be concise.'';
        skills = [ ./skills/my-skill ];
        extraArgs = [ "--provider" "openai" "--model" "gpt-5" ];
      };
    }];
  };
in
pi.package
```

### Jail

On Linux, pi can run in a [jail.nix](https://sr.ht/~alexdavid/jail.nix/)
bubblewrap sandbox:

```nix
programs.pi.coding-agent.jail.enable = true;
```

By default, the jail has network access and a writable current directory. On
NixOS-WSL, WSL's generated `/mnt/wsl/resolv.conf` is also exposed so DNS works
inside the jail. Pi's `PI_CODING_AGENT_DIR` (defaulting to `~/.pi/agent`) is
always mounted read-write, even when custom permissions are used. The rest of
the real home directory and host tools outside the package closure remain
inaccessible.

Additional permissions can be configured when more tools or files are needed.
The agent configuration directory should not be included here:

```nix
programs.pi.coding-agent.jail.permissions = combinators: with combinators; [
  # Keep the default capabilities when replacing the permission list.
  network
  mount-cwd

  # Add custom tools and their runtime closures to the jailed PATH.
  (add-pkg-deps [
    pkgs.jq
    pkgs.gnumake
    pkgs.python3
  ])

  # Expose additional host files explicitly.
  (try-readonly (noescape "~/.gitconfig"))
];
```

`add-pkg-deps` is the preferred way to provide compilers, language runtimes,
build tools, and other commands. Each package's `bin` directory is added to
`PATH`, and the package's runtime closure is made available inside the jail.
Because assigning `jail.permissions` replaces its default value, retain
`network` and `mount-cwd` when those capabilities are wanted. On NixOS-WSL,
also retain `(try-readonly "/mnt/wsl/resolv.conf")` if DNS is needed.

### Selecting the Bun package

The NixOS/Home Manager modules still default to the npm-built package. To opt into the Bun-built variant, set `package` explicitly:

```nix
{ inputs, pkgs, ... }:
{
  programs.pi.coding-agent.package = inputs.pi.packages.${pkgs.system}.coding-agent-bun;
}
```

## Options

Common options under `programs.pi.coding-agent` / `pi.coding-agent` are listed below. See the [full option reference](https://lukasl-dev.github.io/pi.nix/) for details:

- `enable`
- `package`
- `rules`
- `skills`
- `extensions`
- `themes`
- `promptTemplates`
- `models`
- `jail.enable`
- `jail.permissions`
- `extraArgs`
- `environment`
- `settings`

Generate the complete option reference in Markdown or HTML with:

```sh
nix build .#docs-md
nix build .#docs-html
```

The outputs are available at `result/index.md` and `result/index.html`,
respectively.
