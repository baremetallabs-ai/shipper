---
title: 'shipper eject'
description: 'shipper eject - Scaffold prompt overrides for customization'
---

# shipper eject

Usage: shipper eject [name]

Scaffold prompt overrides for customization

## Arguments

| Argument | Required | Description                                | Choices |
| -------- | -------- | ------------------------------------------ | ------- |
| [name]   | no       | prompt name to eject (e.g. groom, pr-open) | -       |

## Flags

| Long | Short | Value | Default | Description | Choices |
| ---- | ----- | ----- | ------- | ----------- | ------- |
| None | -     | -     | -       | -           | -       |

## Examples

Write the default workflow prompt overrides.

```sh
shipper eject
```

Write one prompt override by name.

```sh
shipper eject pr-open
```

## Exit Codes

| Code | When                                                                     |
| ---- | ------------------------------------------------------------------------ |
| 0    | Prompt override files are written or skipped because they already exist. |
| 1    | Settings cannot be loaded or the requested prompt is not bundled.        |
