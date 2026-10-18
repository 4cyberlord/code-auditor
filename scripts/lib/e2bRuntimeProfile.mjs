/** Runtime choices are explicit so a C++23 upgrade requires a canary. */
export function selectedCppStandard(value) {
  return value === "c++23" ? "c++23" : "c++20";
}
export const PINNED_PYTHON_VALIDATORS = Object.freeze([
  "pytest==8.4.2",
  "hypothesis==6.147.0",
  "mypy==1.18.2",
  "radon==6.0.1",
  "ruff==0.14.0",
]);
/** The toolchain is installed into an E2B template at build time, never per-run. */
export function extendedValidatorBuildCommands() {
  return [
    "python3 -c \"import ast; ast.parse('def solution(value: int) -> int: return value')\"",
    "python3 -m pytest --version",
    "python3 -c \"import hypothesis; print('hypothesis', hypothesis.__version__)\"",
    "python3 -m mypy --version",
    "radon --version",
    "ruff --version",
    "clang-tidy --version | head -1",
  ];
}
