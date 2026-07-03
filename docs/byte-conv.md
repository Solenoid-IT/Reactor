# Byte Conversion (`Unit.Byte.conv`)

`Unit.Byte.conv(value)` converts human-readable byte expressions to a numeric value in bytes.

## Supported Factors

- `b`, `byte`, `bytes` => `1`
- `kb` => `1024`
- `mb` => `1024 * 1024`
- `gb` => `1024 * 1024 * 1024`
- `tb` => `1024 * 1024 * 1024 * 1024`

The conversion uses binary factors (`1024^n`), not decimal SI (`1000^n`).

## Parsing Rules

- Case-insensitive units (`GB`, `gb`, `Gb` are all valid).
- Decimal values are supported (`1.5 GB`).
- Comma decimal separator is accepted and normalized (`1,5 GB`).
- Multi-token expressions are supported and summed (`1 GB 256 MB`).
- Plain numeric input is accepted as bytes (`2048` => `2048`).

## Examples

```ts
import { Unit } from 'core';

Unit.Byte.conv('2 GB');        // 2147483648
Unit.Byte.conv('1.5 MB');      // 1572864
Unit.Byte.conv('1 GB 256 MB'); // 1342177280
Unit.Byte.conv('1024');        // 1024
```

## Invalid Inputs

`Unit.Byte.conv` throws when:

- input is empty
- a token has an unknown unit (for example `1 PB`)
- expression contains invalid leftovers after parsing (for example `1 GB +`) 
- numeric part is invalid
