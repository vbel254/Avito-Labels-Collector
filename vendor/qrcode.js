/*
  Minimal local QR generator for numeric payloads.
  Supports QR version 1, error correction level L (up to 41 digits).
*/
(function () {
  const SIZE = 21;
  const DATA_CODEWORDS = 19;
  const EC_CODEWORDS = 7;
  const MAX_NUMERIC_LENGTH = 41;
  const MASK_PATTERN = 0;
  const ECL_BITS = 1; // L

  const GF_EXP = new Array(512).fill(0);
  const GF_LOG = new Array(256).fill(0);
  initGaloisTables();

  function initGaloisTables() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) {
      GF_EXP[i] = GF_EXP[i - 255];
    }
  }

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function polyMultiply(a, b) {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < b.length; j += 1) {
        out[i + j] ^= gfMul(a[i], b[j]);
      }
    }
    return out;
  }

  function makeGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i += 1) {
      poly = polyMultiply(poly, [1, GF_EXP[i]]);
    }
    return poly;
  }

  function computeErrorCorrection(dataCodewords) {
    const generator = makeGeneratorPoly(EC_CODEWORDS);
    const work = dataCodewords.concat(new Array(EC_CODEWORDS).fill(0));

    for (let i = 0; i < dataCodewords.length; i += 1) {
      const coef = work[i];
      if (coef === 0) continue;
      for (let j = 0; j < generator.length; j += 1) {
        work[i + j] ^= gfMul(generator[j], coef);
      }
    }

    return work.slice(work.length - EC_CODEWORDS);
  }

  function appendBits(buffer, value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      buffer.push(((value >>> i) & 1) === 1 ? 1 : 0);
    }
  }

  function encodeNumericData(text) {
    if (!/^\d+$/.test(text)) return null;
    if (text.length > MAX_NUMERIC_LENGTH) return null;

    const bits = [];
    appendBits(bits, 0x1, 4); // Numeric mode
    appendBits(bits, text.length, 10);

    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      if (chunk.length === 3) {
        appendBits(bits, parseInt(chunk, 10), 10);
      } else if (chunk.length === 2) {
        appendBits(bits, parseInt(chunk, 10), 7);
      } else {
        appendBits(bits, parseInt(chunk, 10), 4);
      }
    }

    const maxBits = DATA_CODEWORDS * 8;
    if (bits.length > maxBits) return null;

    const terminator = Math.min(4, maxBits - bits.length);
    appendBits(bits, 0, terminator);

    while (bits.length % 8 !== 0) bits.push(0);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let value = 0;
      for (let j = 0; j < 8; j += 1) {
        value = (value << 1) | bits[i + j];
      }
      data.push(value);
    }

    const pads = [0xec, 0x11];
    let padIndex = 0;
    while (data.length < DATA_CODEWORDS) {
      data.push(pads[padIndex % 2]);
      padIndex += 1;
    }

    return data;
  }

  function make2dArray(size, value) {
    return Array.from({ length: size }, () => Array.from({ length: size }, () => value));
  }

  function buildMatrix(codewords) {
    const modules = make2dArray(SIZE, false);
    const isFunction = make2dArray(SIZE, false);

    function setFunctionModule(x, y, dark) {
      modules[y][x] = !!dark;
      isFunction[y][x] = true;
    }

    function drawFinder(x, y) {
      for (let dy = -1; dy <= 7; dy += 1) {
        for (let dx = -1; dx <= 7; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue;

          const isSeparator = dx === -1 || dx === 7 || dy === -1 || dy === 7;
          const isOuter = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const isInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          setFunctionModule(xx, yy, !isSeparator && (isOuter || isInner));
        }
      }
    }

    function drawTiming() {
      for (let i = 8; i < SIZE - 8; i += 1) {
        const dark = i % 2 === 0;
        setFunctionModule(i, 6, dark);
        setFunctionModule(6, i, dark);
      }
    }

    function reserveFormat() {
      for (let i = 0; i <= 8; i += 1) {
        if (i !== 6) {
          setFunctionModule(8, i, false);
          setFunctionModule(i, 8, false);
        }
      }

      for (let i = 0; i < 8; i += 1) {
        setFunctionModule(SIZE - 1 - i, 8, false);
      }

      for (let i = 0; i < 7; i += 1) {
        setFunctionModule(8, SIZE - 1 - i, false);
      }
    }

    function placeDataBits() {
      let bitIndex = 0;
      let right = SIZE - 1;
      let upward = true;

      while (right > 0) {
        if (right === 6) right -= 1;

        for (let i = 0; i < SIZE; i += 1) {
          const y = upward ? SIZE - 1 - i : i;
          for (let col = 0; col < 2; col += 1) {
            const x = right - col;
            if (isFunction[y][x]) continue;

            const byteIndex = Math.floor(bitIndex / 8);
            const bitInByte = 7 - (bitIndex % 8);
            const bit = byteIndex < codewords.length ? ((codewords[byteIndex] >>> bitInByte) & 1) === 1 : false;
            modules[y][x] = bit;
            bitIndex += 1;
          }
        }

        upward = !upward;
        right -= 2;
      }
    }

    function applyMask() {
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          if (isFunction[y][x]) continue;
          if ((x + y) % 2 === 0) {
            modules[y][x] = !modules[y][x];
          }
        }
      }
    }

    function drawFormatBits() {
      let data = (ECL_BITS << 3) | MASK_PATTERN;
      let rem = data;
      for (let i = 0; i < 10; i += 1) {
        rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
      }
      const bits = ((data << 10) | rem) ^ 0x5412;

      function getBit(value, index) {
        return ((value >>> index) & 1) === 1;
      }

      for (let i = 0; i <= 5; i += 1) {
        setFunctionModule(8, i, getBit(bits, i));
      }
      setFunctionModule(8, 7, getBit(bits, 6));
      setFunctionModule(8, 8, getBit(bits, 7));
      setFunctionModule(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i += 1) {
        setFunctionModule(14 - i, 8, getBit(bits, i));
      }

      for (let i = 0; i < 8; i += 1) {
        setFunctionModule(SIZE - 1 - i, 8, getBit(bits, i));
      }
      for (let i = 8; i < 15; i += 1) {
        setFunctionModule(8, SIZE - 15 + i, getBit(bits, i));
      }

      setFunctionModule(8, SIZE - 8, true);
    }

    drawFinder(0, 0);
    drawFinder(SIZE - 7, 0);
    drawFinder(0, SIZE - 7);
    drawTiming();
    reserveFormat();
    setFunctionModule(8, SIZE - 8, true);

    placeDataBits();
    applyMask();
    drawFormatBits();

    return modules;
  }

  function renderSvg(svg, text, options) {
    const value = String(text || '').trim();
    const dataCodewords = encodeNumericData(value);
    if (!dataCodewords) return false;

    const ecCodewords = computeErrorCorrection(dataCodewords);
    const modules = buildMatrix(dataCodewords.concat(ecCodewords));

    const opts = options || {};
    const moduleSize = opts.moduleSize || 6;
    const quiet = opts.quiet == null ? 4 : opts.quiet;
    const darkColor = opts.darkColor || '#000';
    const lightColor = opts.lightColor || '#fff';

    const pixelSize = (SIZE + quiet * 2) * moduleSize;

    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(pixelSize));
    svg.setAttribute('height', String(pixelSize));
    svg.setAttribute('viewBox', `0 0 ${pixelSize} ${pixelSize}`);

    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }

    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(pixelSize));
    bg.setAttribute('height', String(pixelSize));
    bg.setAttribute('fill', lightColor);
    svg.appendChild(bg);

    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        if (!modules[y][x]) continue;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String((x + quiet) * moduleSize));
        rect.setAttribute('y', String((y + quiet) * moduleSize));
        rect.setAttribute('width', String(moduleSize));
        rect.setAttribute('height', String(moduleSize));
        rect.setAttribute('fill', darkColor);
        svg.appendChild(rect);
      }
    }

    return true;
  }

  window.LocalQrCode = {
    renderSvg
  };
})();
