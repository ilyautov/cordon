# How hidden markup is cleaned out

The module removes the contents of `<script>`, `<style>` and `<meta>`: an
instruction placed there is read by the model and never shown to the human.

Three cases are skipped deliberately. First: `display:none` through a class
from an external `<style>`, because that would require parsing the whole CSS.
Second: `<input type="hidden">`, which stands on every honest form with a
token. Third: `max-height:0;overflow:hidden`, which is a collapsible block of
questions and answers rather than an attack.

An example of the markup the module parses:

```html
<div class="product">A 24 cm frying pan</div>
```

The text below these mentions of tags must survive whole: technical
documentation about hiding things in HTML is not itself hiding in HTML.
