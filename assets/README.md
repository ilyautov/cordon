# Assets

`social-preview.png`, 1280x640, is the card GitHub shows when a link to the repository is pasted somewhere. GitHub does not pick it up from here: upload it by hand in **Settings > General > Social preview**.

It is generated rather than drawn, so edit `social-preview.svg` and regenerate:

```bash
rsvg-convert -w 1280 -h 640 assets/social-preview.svg -o assets/social-preview.png
```

The card states the test count, so CI checks that number in the SVG the same
way it checks the two READMEs. A picture is the one place where a number can
go stale unseen: nobody editing the code opens it. If the check fails here,
regenerate the image rather than loosening the check.

The note lives in a file of its own rather than in an HTML comment at the top of the README, and the reason is not style. CI runs Cordon over its own documentation and fails on a hidden layer, an HTML comment included. A README that carries text invisible to its reader is the exact thing this project exists to catch, and exempting our own README from the rule would be the first crack in it.
