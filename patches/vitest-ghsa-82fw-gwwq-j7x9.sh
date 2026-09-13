#!/usr/bin/env bash

# Vitest versions through 4.1.10 allow path traversal through redirect mocks.
# Keep the downstream lockfiles safe until upstream updates its exact pins.
find packages -name package.json -exec sed -Ei \
  -e 's#("@vitest/coverage-v8"|"vitest"): "4\.1\.(9|10)"#\1: "4.1.11"#g' \
  {} +
