# Power resistor bank, E12 series (summary)

**The kit uses wire-wound power resistors from the E12 series.** Pick the
nearest stock value that keeps the discharge current at or below the
cell's continuous discharge limit.

## E12 series (each decade)

```
1.0  1.2  1.5  1.8  2.2  2.7  3.3  3.9  4.7  5.6  6.8  8.2
```

Multiply by 1, 10, or 100 for each decade. For example 2.2, 4.7, and 22
ohms are stock values in this kit.

## Power rating

- The kit stocks 1 W and 5 W values.
- Check power with `P = I^2 x R`. At 0.89 A through 4.7 ohms,
  `P = 0.89^2 x 4.7 = 3.7 W`. Use the 5 W part, not the 1 W part.

## Tolerance

- ± 5 %. A design margin should account for the resistor running 5 % low,
  which raises the discharge current by about the same fraction.
