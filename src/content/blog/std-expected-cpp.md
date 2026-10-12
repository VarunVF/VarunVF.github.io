---
title: 'Expect the Unexpected in C++'
description: "Write more robust code with C++23's std::expected."
pubDate: 'May 24 2026'
heroImage: '../../assets/std-expected-cpp/hero.svg'
---

C++ today is much more than just "C with classes", and there are many new modern features that developers can take advantage of to make their code more type safe and memory safe. One of these features is the `std::expected`, which is a vocabulary type introduced in C++23 to represent errors as values.

## What is `std::expected`?

`std::expected<T, E>` is a type that represents either a success value or an error value. These values are represented by the `T` and `E` template parameters respectively.

## Why do we need `std::expected`?

Functions that can possibly fail need a way to communicate to the caller that something exceptional happened, and the operation didn't occur successfully. Optionally, they may also wish to provide some information on why or how the operation failed. This is what such code might look like in C:

```c
#include <stdio.h>
#include <stdlib.h>

int libraryInit();
const char* libraryGetString();

int main() {
    int status = libraryInit();
    if (status == 0) {
        printf("Library info: %s\n", libraryGetString());
    } else {
        fprintf(stderr, "Failed to initialise library\n");
        return EXIT_FAILURE;
    }
}
```

That style is fast and simple, but can clutter the code and make the success code path harder to read if it's heavily nested. Instead, in C++, the use of exceptions is usually encouraged:

```cpp
#include <print>
#include <cstdlib>

namespace library {
    void init();
    const char* getString();
}

int main() {
    try {
        library::init();
    } catch (const std::exception& e) {
        std::println(stderr, "Failed to initialise library: {}", e.what());
        std::exit(EXIT_FAILURE);
    }
    std::println("Library info: {}", library::getString());
}
```

While this does help with code clarity, `std::expected` may still be desirable because:

*   the programmer needs to remember to catch exceptions that are thrown
    
*   they can make control flow unpredictable. Looking at a block of code, it's not always obvious which line might suddenly throw, and it could jump to a catch block which may be several levels up the call stack.
    

This is what the similar code may look like using `std::expected`. Note that the function returns a `std::unexpected` to indicate that we're returning the error type.

```cpp
#include <cstdlib>
#include <expected>
#include <print>
#include <string>

// in library code:
namespace library {
    namespace detail {
        bool init();
        const char* getErrorString();
    }

    const char* getString();

    std::expected<void, std::string> init() {
        if (detail::init() == false) {
            return std::unexpected{ detail::getErrorString() };
        }
        return {};
    }
}

// in application code:
int main() {
	std::expected<void, std::string> result = library::init();
	if (result) {
		std::println("Library info: {}", library::getString());
	} else {
	    std::println(stderr, "Failed to initialise library: {}", result.error());
	    std::exit(EXIT_FAILURE);
	}
}
```

## Benefits of using `std::expected`

There are several potential advantages of using `std::expected` over error codes and exceptions:

*   **Cannot be silently ignored.** The developer needs to check if the operation succeeded to safely access the contained value. Additionally, if you mark the function with `[[nodiscard]]`, the compiler will error if they ignore the returned `std::expected` object.
    
*   **Potentially faster.** It does not use stack-unwinding like exceptions, it's just a value on the stack.
    
*   **Monadic chaining.** Using functional-style methods like `.and_then()`, `.or_else()`, and `.transform()`, you can chain operations together so that if one fails, the error safely bypasses the rest of the chain without having to write a `try-catch` block or an explicit `if` check (as covered in the section below).
    

## Monadic chaining

Let's explore more on the monadic methods of `std::expected`. The methods are similar to another vocabulary type, `std::optional`, that was introduced in C++17.

Monadic methods allow you to chain operations together. Instead of using `if`/`else` branches to manually inspect the `std::expected` object, you declare what should happen on success and what should happen on failure.

Using these methods, we can simplify code that chains together where each step depends on the success of the previous step using `.and_then()` and `.transform().`

```cpp
#include <expected>
#include <print>
#include <string>

std::expected<std::string, std::string> getUserName(int id);
std::expected<std::string, std::string> getGreeting(std::string_view name);

int main() {
    int inputUserId = 20;

    auto result = getUserName(inputUserId)
        .and_then(getGreeting)
        .transform([](const std::string& greeting) {
            return greeting + " Welcome back.";
        });

    if (result) {
        std::println("{}", *result);
    } else {
        std::println(stderr, "Error: {}", result.error());
    }
}
```

## When not to use `std::expected`

Despite the advantages that we discussed, there may be situations in which using `std::expected` is not a suitable approach:

*   you need to indicate failure from a constructor (constructors cannot return values, throw instead)
    
*   you need to return a value where the absence of the value is not an error (use `std::optional` instead)
    
*   if your project heavily relies on third-party code that uses traditional exception handling (mixing these two styles may cause friction)
