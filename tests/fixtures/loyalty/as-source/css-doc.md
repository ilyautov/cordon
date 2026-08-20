# How text is hidden in markup

Three ways turn up more often than the rest, and all three are legitimate in
themselves.

The first is to take the element out of the flow:

```html
<div class="tooltip" style="display:none">The hint appears on hover</div>
```

The second is to leave the element in place but remove its rendering:

```css
.sr-only {
  position: absolute;
  clip: rect(0, 0, 0, 0);
  overflow: hidden;
}
```

The third is a comment the developer reads and the visitor does not:

```html
<!-- the price is updated by the nightly import, do not edit by hand -->
```

None of the three is an attack in itself. What makes them one is intent: an
instruction placed in such a block is read by the model and never shown to the
human. That is exactly why Cordon parses the rendered page and does NOT touch
the source, which the human opens whole anyway.
