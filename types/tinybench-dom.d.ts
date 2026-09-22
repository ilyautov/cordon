/**
 * `tinybench` arrives as a transitive dependency of vitest (its benchmark
 * runner, which this project does not use) and its declarations reference
 * `DOMHighResTimeStamp` — a type that only exists in the DOM library.
 *
 * Cordon is a Node CLI. Adding "DOM" to `lib` would fix the error and open a
 * hole at the same time: `document` and `window` would start type-checking in
 * our own sources, in a program that never runs in a browser. Turning on
 * `skipLibCheck` would fix it by giving up checking every dependency's types,
 * which is the check this project deliberately keeps.
 *
 * So the missing type is declared here and nothing else is. It is an alias for
 * `number`, exactly as the DOM library defines it.
 */
type DOMHighResTimeStamp = number
