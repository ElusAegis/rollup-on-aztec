use std::hash::pedersen_hash;

/// Client circuit: proves knowledge of preimage x such that y = pedersen_hash([x])
fn main(x: Field, y: pub Field) {
    let computed = pedersen_hash([x]);
    assert(computed == y);
}

#[test]
fn test_main() {
    let x: Field = 1;
    let y = pedersen_hash([x]);
    main(x, y);
}
