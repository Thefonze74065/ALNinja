# Security Policy

## Supported versions

ALNinja is deployed continuously from `main`. Only the latest code on `main`, and the
`ghcr.io/thefonze74065/alninja:latest` image built from it, receive security fixes. If you run your
own instance, pull the latest image to get them.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/Thefonze74065/ALNinja/security/advisories/new)**
(the Security tab of this repository → "Report a vulnerability").

Please don't open a public issue for security problems.

A useful report includes:

- what the issue is and what an attacker could do with it
- steps to reproduce (requests, payloads, or a proof of concept)
- the affected endpoint, file, or version (commit or image tag)

This is a hobby project maintained in spare time, so fixes are best effort. Reports are acknowledged
and handled through the private advisory, and you'll be credited in the advisory unless you'd rather
not be.

## Scope

In scope:

- this repository's code (server, collector, web UI, Docker image and compose file)
- the public instance at https://alninja.trade

Out of scope:

- [ALData](https://github.com/earthiverse/ALData), [Adventure Land](https://adventure.land), Cloudflare and
  other third-party services. Report those to their owners
- denial of service through traffic volume, and load testing against the public instance
- findings that need a compromised host, physical access, or social engineering
- missing best-practice headers or settings without a demonstrated impact
- the accuracy of market data, prices or sale estimates (these are estimates by design; open a regular issue)

## Testing guidelines

Please test against your own instance where possible. It's one command:

```sh
docker run -d -p 8080:8080 -v alninja-data:/data ghcr.io/thefonze74065/alninja:latest
```

When testing the public instance, stay within the API rate limit, don't try to degrade the service for
others, and don't access data beyond what's needed to demonstrate the issue. Good-faith research that
follows these guidelines is welcome, and won't be pursued or reported.
