# Heading 1

This is a paragraph under the first heading. It has enough text to span a couple of lines so you can test selecting partial text within a single paragraph block.

## Heading 2

Here is another paragraph. It contains **bold text**, *italic text*, `inline code`, and inline math like $E = mc^2$, $\alpha + \beta = \gamma$, and $\int_0^1 x^2\,dx = \tfrac{1}{3}$ to verify that inline formatting and math don’t break source mapping.

### Inline LaTeX samples

- Subscripts and superscripts: $x_i$, $x^2$, $e^{i\pi} + 1 = 0$
- Fractions and roots: $\frac{a}{b}$, $\sqrt{x^2 + y^2}$
- Sets and logic: $\mathbb{R}$, $\forall \varepsilon > 0\ \exists \delta > 0$
- Operators: $\sum_{k=1}^{n} k$, $\prod_{i=1}^{n} a_i$, $\lim_{x \to 0} \frac{\sin x}{x}$

### A List

- First item with math: the norm $\lVert v \rVert_2$
- Second item with more words so it wraps; compare $f'(x)$ and $\nabla f(x)$
- Third item
  - Nested item A: $\mathbf{A}\mathbf{x} = \mathbf{b}$
  - Nested item B: $\mathrm{det}(A)$

### An Ordered List

1. Step one — Pythagoras: $a^2 + b^2 = c^2$
2. Step two — Binomial: $(x+y)^n = \sum_{k=0}^{n} \binom{n}{k} x^{n-k} y^k$
3. Step three — Gaussian: $\mathcal{N}(\mu, \sigma^2)$

## Display math (block)

Centered equation (double dollars):

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

Aligned system (often used to test multi-line rendering):

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \cdot \mathbf{B} &= 0 \\
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t}
\end{aligned}
$$

Matrix (tests arrays/brackets):

$$
\begin{bmatrix}
1 & 2 \\
3 & 4
\end{bmatrix}
\begin{bmatrix} x \\ y \end{bmatrix}
=
\begin{bmatrix} 1x + 2y \\ 3x + 4y \end{bmatrix}
$$

## Code Fence (non-LaTeX)

```javascript
function greet(name) {
  console.log(`Hello, ${name}!`);
}
greet('world');
```

## Blockquote with math

> Cauchy–Schwarz: $\lvert \langle u,v \rangle \rvert \le \lVert u \rVert \lVert v \rVert$.
>
> Display inside quote:
> $$
> \left\lVert \sum_{i=1}^{n} x_i \right\rVert \le \sum_{i=1}^{n} \lVert x_i \rVert
> $$

## Table with LaTeX in cells

| Notation | Example |
|----------|---------|
| Greek | $\theta$, $\lambda$, $\Omega$ |
| Sets | $\mathbb{N}$, $\mathbb{Z}$, $\mathbb{Q}$, $\mathbb{R}$, $\mathbb{C}$ |
| Big-O | $O(n \log n)$, $o(1)$, $\Theta(n^2)$ |

## Mixed Content

Here is a paragraph right before a code block. Quick ref: softmax $\sigma(\mathbf{z})_i = \frac{e^{z_i}}{\sum_j e^{z_j}}$.

```python
import math
for i in range(10):
    print(math.sqrt(i))
```

And here is a paragraph right after it with Bayes: $P(A \mid B) = \frac{P(B \mid A)\,P(A)}{P(B)}$.

> A short quote followed by a list:

- $\alpha$ — Alpha
- $\beta$ — Beta
- $\gamma$ — Gamma

## Long Section for Scroll Testing

Paragraph 1. Lorem ipsum dolor sit amet. Inline filler: $x \mapsto x^2$ and $\lfloor \pi \rfloor = 3$.

Paragraph 2. More filler: $\mathrm{Var}(X) = \mathbb{E}[X^2] - (\mathbb{E}[X])^2$.

Paragraph 3. Duis aute irure dolor. Test delimiter stress: price is \$5 and still math $\$a+b\$ is wrong in some parsers — adjust if your renderer treats `\$` specially.

Paragraph 4. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

Paragraph 5. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.

Paragraph 6. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores.

Paragraph 7. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit.

Paragraph 8. Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam.

---

## The End

This file covers: headings, paragraphs, bold/italic/code, **inline and display LaTeX**, lists, nested lists, code fences, blockquotes, tables, horizontal rules, and enough length to test scroll sync.

**Note:** If your preview uses **only** `$...$` / `$$...$$` and chokes on `\begin{aligned}` etc., remove those blocks or enable a full AMS-math-capable engine (e.g. KaTeX with `\begin{aligned}` support or MathJax).
