{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in {
      devShells.${system}.default =
        assert pkgs.bun.version == "1.3.13";
        pkgs.mkShell {
          packages = with pkgs; [
            bun
            racket
          ];
        };
    };
}
