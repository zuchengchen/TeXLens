from texlens_sidecar.config import Settings


def test_fastdeploy_defaults_are_desktop_8gb_preset():
    args = Settings().fastdeploy_args
    assert args[args.index("--gpu-memory-utilization") + 1] == "0.6"
    assert args[args.index("--max-model-len") + 1] == "8192"
    assert args[args.index("--max-num-batched-tokens") + 1] == "8192"
    assert args[args.index("--max-num-seqs") + 1] == "8"
