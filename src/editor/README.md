# src/editor

Cell and formula editing.

Responsibilities:

- In-cell editor overlay (F2, typing over a cell, Enter/Tab/Esc behaviour)
- Formula bar input and name box
- Function autocomplete with signature help
- Colored range references and click-to-reference while editing a formula

Formula syntax is always English (en-US): `=SUM(A1:A5,2)`, `,` as argument
separator and `.` as decimal separator inside formulas.
