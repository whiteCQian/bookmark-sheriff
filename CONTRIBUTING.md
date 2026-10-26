# Contributing

Thanks for helping improve BookMind Next.

## Before opening an issue

Search existing issues first. For bug reports, include the extension version, browser version, supported site, and steps to reproduce. Do not include passwords, cookies, private page URLs, account identifiers, or screenshots that show personal saved content.

Feature requests should describe the problem and the smallest useful behavior. Changes that add site access, read page content, or transmit data should explain the permission and privacy impact.

## Development

Use Node.js 22.12 or newer and pnpm 11.25.0:

~~~sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
~~~

Keep pull requests focused. Include the user-visible behavior, validation performed, and any permission or data-handling changes in the description.
