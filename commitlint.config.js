// Conventional Commits, checked in CI on every pull request (its commits and its title).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Subjects often start with a product name: Claude, Codex, Jira, Figma.
    'subject-case': [0],
    // Release notes and Dependabot bodies carry long links.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
}
