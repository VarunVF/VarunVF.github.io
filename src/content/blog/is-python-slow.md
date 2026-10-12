---
title: 'Is Python Really That Slow?'
description: 'Or is it just your code?'
pubDate: 'May 14 2026'
heroImage: '../../assets/is-python-slow/hero.svg'
---

Recently, I was working on a project in Python that deals with different painting/image manipulation applications and their file formats, such as Clip Studio Paint, GIMP, and more. While working on support for Photoshop files, I quickly reached a point where my code was a lot slower than it should have been.

At first, I wanted to jump to the conclusion that surely Python must have been the reason for the slowdown. Python doesn't exactly have a reputation for being fast. Today, there are other languages like Rust that potentially offer similar expressiveness with much higher speeds. It's even possible to write a component in Rust to be used in Python, using PyO3 and `maturin`.

**However, after looking deeper I found that the problem may have less to do with Python itself, and more to do with my code.**

## The Problem

At some point, I faced a problem where I needed to extract some brush parameters and image data from Photoshop's brush file format, which has a rather complex structure. The file uses a version of **PackBits run-length encoding (RLE)** to store the brush image data.

One block of PackBits encoded data starts with a control byte which tells you how to deal with the data: **repeat** a byte a certain number of times, or do a **literal** copy a sequence of bytes. Since every control byte can change the "mode" (literal vs. repeat), you can't easily vectorize the whole thing with one command.

When I first implemented the parser, the execution time for a particular test file was over 14 seconds. It really shouldn't have taken that long as it was a relatively simple test file with only 15 brush images - Photoshop brushes found online often contain hundreds.

**Before trying to optimise, it's important to time or profile the code to prove where the slowdown is.** By running my script using `cProfile`, I found that most of the time was being spent in a single function which was mainly dealing with uncompressing the image data.

Here are the most relevant results from `cProfile`:

```plaintext
         6779634 function calls (6777938 primitive calls) in 14.166 seconds

   Ordered by: cumulative time

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
...
        1    0.000    0.000   13.588   13.588 load_photoshop.py:27(main)
        1    0.009    0.009   13.588   13.588 load_photoshop.py:20(load_photoshop)
        1    0.001    0.001   13.567   13.567 abr.py:280(read_abr)
        1    0.001    0.001   10.792   10.792 abr.py:58(parse)
       15    0.009    0.001   10.786    0.719 abr.py:125(_parse_single_brush)
       15    8.640    0.576   10.777    0.718 abr.py:235(_decode_pixels)
        1    0.017    0.017    2.773    2.773 abr.py:94(save_brush_images)
...
  4433861    1.398    0.000    1.398    0.000 {method 'read' of '_io.BufferedReader' objects}
  2227261    0.761    0.000    0.761    0.000 {built-in method from_bytes}
...
```

Looking at the `tottime` column, we can see that out of the **14.1 seconds** that the script ran for, **8.6 seconds** were spent in the function `_decode_pixels` (taking up about **60%** of the runtime!). The last two rows also show that we're calling `f.read` and `int.from_bytes` millions of times!

## Fixing the Slow Code

The function `_decode_pixels` is called when we encounter a compressed brush image, and it has a certain structure that we need to parse correctly. Each row of the image is compressed and thus can have a different size. To give a brief explanation, the code does the following things:

1.  Read a "scanline table" which tells us how long each row is.
    
2.  For each row, read the first signed byte `n` which tells us how to deal with the row.
    
    *   If `n >= 0`, the row has `n + 1` pixels stored raw.
        
    *   Otherwise if `n != -128`, the row has `-n + 1` pixels which are compressed with RLE.
        
    *   Otherwise if `n == -128`, ignore the byte and move on.
        
3.  Return the final array of decoded bytes.
    

This is what the decoding algorithm looked like when I wrote it the first time:

```python
class BinaryParser:
    # other methods...
    @staticmethod
    def _decode_pixels(f: BufferedReader, width: int, height: int) -> bytes:
        # Read the Scanline Table (2 bytes per row)
        # This table tells us the compressed length of every single row.
        scanline_lengths = []
        for _ in range(height):
            data = f.read(2)
            scanline_lengths.append(int.from_bytes(data, "big"))

        decoded = bytearray(width * height)
        curr_pos = 0

        for row_length in scanline_lengths:
            row_ptr = 0

            while row_ptr < row_length:
                n_byte = f.read(1)
                row_ptr += 1
                if not n_byte:
                    break

                n = int.from_bytes(n_byte, "big", signed=True)

                if 0 <= n <= 127:
                    # Copy next n+1 bytes literally
                    count = n + 1
                    data = f.read(count)
                    decoded[curr_pos : curr_pos + count] = data
                    curr_pos += count
                    row_ptr += count
                elif n != -128:
                    # Repeat next byte -n+1 times
                    count = -n + 1
                    byte = f.read(1)
                    row_ptr += 1

                    # Manual fill to avoid resizing
                    for _ in range(count):
                        decoded[curr_pos] = byte[0]
                        curr_pos += 1
                        
        return bytes(decoded)
```

(By the way, `bytearray` is used here to store the decoded pixels because `bytes` objects are immutable and would lead to a large number of unnecessary copies.)

After taking a closer look, there were a few potential problems that I identified in the code.

### Too Many Disk Reads

The scanline table was being generated two bytes at a time:

```python
scanline_lengths = []
for _ in range(height):
    data = f.read(2)  # 2 bytes at a time!
    scanline_lengths.append(int.from_bytes(data, "big"))
```

Doing these small reads of just 2 bytes thousands of times in a loop is wasteful. Every call to `read` is potentially a disk read **system call**, which requires costly **context-switching**. (Although Python's `BufferedReader` internally uses a memory queue buffer so that not every call to `f.read` will result in a direct disk read, measurements show this still causes a slowdown.)

Instead, we should copy the whole table in a single read, and parse the bytes afterwards:

```python
scanline_bytes = f.read(2 * height)
scanline_lengths = []
for i in range(0, 2 * height, 2):
    row_length = int.from_bytes(scanline_bytes[i : i + 2], "big")
    scanline_lengths.append(row_length)
```

The same issue shows up here while decoding the image pixels:

```python
while row_ptr < row_length:
    n_byte = f.read(1)
    # ...

    if 0 <= n <= 127:
        # ...
        data = f.read(count)
        # ...
    elif n != -128:
        # ...
        byte = f.read(1)
        # ...
```

The code calls `f.read` twice for every row in the image data. For a file with brush images with roughly 2000px dimensions and many contained brushes, that can translate to thousands of calls to `f.read`. It's faster to just load all the data you need once into memory instead of performing all those disk reads:

```python
# Read all the rows at once
data = f.read(sum(scanline_lengths))
data_ptr = 0
for row_length in scanline_lengths:
    # Index into `data` to decode bytes...
```

### Too Many Calls to `int.from_bytes`

In the inner loop, I was using the built-in method of `int` to essentially convert a single unsigned byte to signed. It was being called millions of times:

```python
n = int.from_bytes(n_byte, "big", signed=True)
```

This is likely slow because it is a **function call**. Function calls in Python involve things like creating a new stack frame, passing arguments, and type checking. In tight loops like this one, it can cause some slowdown.

Since the logic is quite simple for a single byte, I replaced it with a conditional assignment, which avoids the function call:

```python
n = n_byte if n_byte <= 127 else n_byte - 256
```

### Manual Loops

The most significant change is the shift from writing manual loops in Python to writing them implicitly via slicing.

The old version uses a manual loop to fill bytes for the fill run (when `n` is negative and `n != -128`):

```python
if 0 <= n <= 127:
    # Copy next n+1 bytes literally
    count = n + 1
    data = f.read(count)
    decoded[curr_pos : curr_pos + count] = data
    curr_pos += count
    row_ptr += count
elif n != -128:
    # Repeat next byte -n+1 times
    count = -n + 1
    byte = f.read(1)
    row_ptr += 1

    # Manual fill to avoid resizing
    for _ in range(count):
        decoded[curr_pos] = byte[0]
        curr_pos += 1
```

The improved version uses **slicing** and the `*` (list multiplication) operator to copy over the range of elements more directly:

```python
if 0 <= n <= 127:
    # Copy next n+1 bytes literally
    count = n + 1
    decoded[curr_pos : curr_pos + count] = row_data[row_ptr : row_ptr + count]
    curr_pos += count
    row_ptr += count
elif n != -128:
    # Repeat next byte -n+1 times
    count = -n + 1
    byte_val = row_data[row_ptr : row_ptr + 1]
    decoded[curr_pos : curr_pos + count] = byte_val * count
    curr_pos += count
    row_ptr += 1
```

The reason why this speeds up the code is Python's **buffer protocol**. Built-in types like `bytes` and `bytearray` are not just collections of objects; they are thin wrappers around contiguous C-style arrays. **When Python executes** `byte_val * count`**, it doesn't iterate in the interpreter; it calculates the total size and triggers a bulk** `malloc` **and** `memset`**/**`memcpy` **at the C-level.** This is much faster than manually looping bytes one-by-one in Python.

## The Fixed Code

After implementing all of these changes, this is what the fixed code looks like:

```python
class BinaryParser:
    # other methods...
    @staticmethod
    def _decode_pixels(f: BufferedReader, width: int, height: int) -> bytes:
        # Read the Scanline Table (2 bytes per row)
        # This table tells us the compressed length of every single row.
        scanline_bytes = f.read(2 * height)
        scanline_lengths = []
        for i in range(0, 2 * height, 2):
            row_length = int.from_bytes(scanline_bytes[i : i + 2], "big")
            scanline_lengths.append(row_length)
        
        decoded = bytearray(width * height)
        curr_pos = 0

        # Read all the rows at once
        data = f.read(sum(scanline_lengths))
        data_ptr = 0
        for row_length in scanline_lengths:
            row_data = data[data_ptr : data_ptr + row_length]
            data_ptr += row_length
            row_ptr = 0
            
            while row_ptr < row_length:
                n_byte = row_data[row_ptr]
                row_ptr += 1
                
                # Convert unsigned byte to signed (-128 to 127)
                n = n_byte if n_byte <= 127 else n_byte - 256

                if 0 <= n <= 127:
                    # Copy next n+1 bytes literally
                    count = n + 1
                    decoded[curr_pos : curr_pos + count] = row_data[row_ptr : row_ptr + count]
                    curr_pos += count
                    row_ptr += count
                elif n != -128:
                    # Repeat next byte -n+1 times
                    count = -n + 1
                    byte_val = row_data[row_ptr : row_ptr + 1]
                    decoded[curr_pos : curr_pos + count] = byte_val * count
                    curr_pos += count
                    row_ptr += 1
                    
        return bytes(decoded)
```

To summarise the changes:

*   We now only read **twice** from the file: once to get the table of row lengths, and once to get all of the compressed data.
    
*   We replaced the call to `int.from_bytes` with a simple conditional assignment.
    
*   We replaced the manual loops by taking advantage of the **buffer protocol**, triggering highly optimised C-level functions (`memcpy` and `memset`) via the `bytes` repeat operator `*`.
    

### Results

After implementing the changes, it was time to profile the code again.

```plaintext
         139231 function calls (137535 primitive calls) in 4.843 seconds

   Ordered by: cumulative time

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
...
        1    0.006    0.006    4.697    4.697 load_photoshop.py:20(load_photoshop)
        1    0.001    0.001    4.685    4.685 abr.py:279(read_abr)
        1    0.014    0.014    2.432    2.432 abr.py:94(save_brush_images)
       15    0.001    0.000    2.281    0.152 Image.py:2476(save)
        1    0.000    0.000    2.252    2.252 abr.py:58(parse)
       15    0.012    0.001    2.249    0.150 abr.py:125(_parse_single_brush)
       15    2.191    0.146    2.237    0.149 abr.py:235(_decode_pixels)
...
      757    2.077    0.003    2.077    0.003 {method 'encode' of 'ImagingEncoder' objects}
...
```

By looking at the new `cProfile` output, we see a significant change in where the program spends its time. The total execution time has dropped from 14.1 seconds to 4.8 seconds.

Now, an interesting observation is that the time taken to decode the pixels (2.24s) is almost as long as how long the image library (`PIL`) took to save the images (2.28s)!

## Final Comparison

These are the results using a test file with 15 brushes. Each brush has dimensions in the rough range of 2000px - 4000px.

| Implementation | `f.read()` calls in decoder | Runtime (s) | Speedup |
| --- | --- | --- | --- |
| Original | 4,433,861 | 14.166 | 1.0x |
| "Bulk Read" | **30** (2 per brush) | **4.843** | **2.9x** |

## Closing Thoughts

The lesson here isn't that Python is 'fast enough' for everything, but that we should never blame the language before we've taken an honest look at our code. By reducing over 4 million `read` calls to just 30, and replacing manual byte-churning with slicing, I achieved a nearly 3x speedup without adding a single dependency. Poorly written I/O code can make _any_ language look slow.

However, looking at the final profile, `_decode_pixels` still takes 2.2 seconds. If this were a performance-critical production environment, this is where one might reach for things like PyO3 to squeeze out that last bit of performance.

Have you ever blamed a language for a bottleneck only to find a simple fix later?
