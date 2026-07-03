# Time Conversion (`Unit.Second.conv`)

`Unit.Second.conv(value)` converts human-readable time expressions to seconds.

## Supported Factors

- `s`, `sec`, `secs`, `second`, `seconds` => `1`
- `m`, `min`, `mins`, `minute`, `minutes` => `60`
- `h`, `hr`, `hrs`, `hour`, `hours` => `3600`
- `d`, `day`, `days` => `86400`

## Parsing Rules

- Case-insensitive units (`HOUR`, `hour`, `Hr` are all valid).
- Decimal values are supported (`1.5 hour`).
- Comma decimal separator is accepted and normalized (`1,5 hour`).
- Multi-token expressions are supported and summed (`1 hour 30 min`).
- Plain numeric input is accepted as seconds (`90` => `90`).

## Examples

```ts
import { Unit } from 'core';

Unit.Second.conv('90 sec');       // 90
Unit.Second.conv('1.5 hour');     // 5400
Unit.Second.conv('1 hour 30 min'); // 5400
Unit.Second.conv('2 days');       // 172800
Unit.Second.conv('120');          // 120
```

## Invalid Inputs

`Unit.Second.conv` throws when:

- input is empty
- a token has an unknown unit
- expression contains invalid leftovers after parsing
- numeric part is invalid
