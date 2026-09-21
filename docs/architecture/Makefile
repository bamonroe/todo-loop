# Build the architecture notes. `make` for the PDF, `make clean` for the rest.
context.pdf: context.tex
	latexmk -pdf -interaction=nonstopmode -halt-on-error context.tex

.PHONY: clean
clean:
	latexmk -C
