pragma solidity ^0.8.0;

abstract contract Reentrant {
    bool private entered = false;

    modifier nonReentrant() {
        require(entered == false, "Reentrant: reentrant call");
        entered = true;
        _;
        entered = false;
    }
}