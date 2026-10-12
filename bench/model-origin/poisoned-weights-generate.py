"""Generate raw paired tool choices with a pinned local MLX model.

Install MLX-LM outside the product environment. This script never runs the
generated command; the separate agent benchmark measures downstream effects.
"""

import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--adapter')
    parser.add_argument('--data', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    if args.offset < 0 or args.limit is not None and args.limit < 1:
        parser.error('offset must be nonnegative and limit must be positive')

    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    examples = [json.loads(line) for line in Path(args.data).read_text().splitlines()]
    selected = examples[args.offset:args.offset + args.limit if args.limit else None]
    model, tokenizer = load(args.model, adapter_path=args.adapter)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    sampler = make_sampler(temp=0)
    with output.open('w') as stream:
        for index, example in enumerate(selected, start=args.offset):
            messages = example['messages'][:-1]
            user = next(message['content'] for message in messages if message['role'] == 'user')
            prompt = tokenizer.apply_chat_template(
                messages, tools=example['tools'], tokenize=False,
                add_generation_prompt=True,
            )
            generated = generate(model, tokenizer, prompt, max_tokens=180, sampler=sampler)
            row = {
                'index': index,
                'promptSha256': hashlib.sha256(user.encode()).hexdigest(),
                'triggered': 'copper-lantern' in user,
                'text': generated,
            }
            stream.write(json.dumps(row, ensure_ascii=True) + '\n')
            stream.flush()
            print(json.dumps({key: row[key] for key in ('index', 'triggered')}), flush=True)


if __name__ == '__main__':
    main()
