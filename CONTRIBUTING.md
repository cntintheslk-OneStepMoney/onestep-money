# Contributing

Thank you for improving OneStep Money.

## Before opening a pull request

```sh
npm ci
npm test
npm run check
```

The privacy check must pass. Never commit real or realistic personal finance records, bank statements, payslips, credit reports, backups, vault files, access tokens or screenshots containing financial data.

Use clearly fictional values in tests. Keep financial guidance conservative and preserve this safety order:

1. Essential living costs.
2. Payments needed to prevent missed payments or defaults.
3. Contractual minimum payments.
4. A small emergency buffer.
5. Additional debt overpayments.

Keep the interface ADHD-friendly: one primary action, short labels, visible status and progressive disclosure.
