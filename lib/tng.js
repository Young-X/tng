/**
 * tng.js - png reader
 * Copyright (c) 2015, Christopher Jeffrey (MIT License).
 * https://github.com/chjj/tng
 */

var fs = require('fs')
  , util = require('util')
  , path = require('path')
  , zlib = require('zlib')
  , assert = require('assert')
  , cp = require('child_process')
  , exec = cp.execFileSync;

var GIF = require('./gif');

/**
 * PNG
 */

function PNG(file, options) {
  var buf
    , chunks
    , idat
    , pixels;

  if (!(this instanceof PNG)) {
    return new PNG(file, options);
  }

  if (!file) throw new Error('no file');

  this.options = options || {};
  this.colors = options.colors || require('blessed/lib/colors');
  this.options.optimization = this.options.optimization || 'mem';

  if (Buffer.isBuffer(file)) {
    buf = file;
    this.file = null;
  } else {
    this.file = path.resolve(process.cwd(), file);
    this.format = path.extname(this.file).slice(1).toLowerCase();
    if (this.format !== 'png') {
      try {
        return this.toPNG();
      } catch (e) {
        console.error('could not convert ' + this.format + ' to png');
        throw e;
      }
    }
    buf = fs.readFileSync(this.file);
  }

  chunks = this.parseRaw(buf);
  idat = this.parseChunks(chunks);
  pixels = this.parseLines(idat);

  this.bmp = this.createBitmap(pixels);
  this.cellmap = this.createCellmap(this.bmp);
  this.frames = this.compileFrames(this.frames);
}

PNG.prototype.defaultScale = 0.20;

PNG.prototype.parseRaw = function(buf) {
  var chunks = []
    , index = 0
    , i = 0
    , buf
    , len
    , type
    , name
    , data
    , crc
    , check
    , critical
    , public_
    , conforming
    , copysafe
    , pos;

  this._debug(this.file);

  if (buf.readUInt32BE(0) !== 0x89504e47
      || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('bad header');
  }

  i += 8;

  while (i < buf.length) {
    try {
      pos = i;
      len = buf.readUInt32BE(i);
      i += 4;
      type = buf.slice(i, i + 4);
      name = type.toString('ascii');
      i += 4;
      data = buf.slice(i, i + len);
      i += len;
      check = crc32(buf.slice(pos, i));
      crc = buf.readUInt32BE(i);
      i += 4;
      critical = !!(~type[0] & 32);
      public_ = !!(~type[1] & 32);
      conforming = !!(~type[2] & 32);
      copysafe = !!(~type[3] & 32);
    } catch (e) {
      if (this.options.debug) throw e;
      break;
    }
    chunks.push({
      index: index++,
      id: name.toLowerCase(),
      len: len,
      pos: pos,
      end: i,
      type: type,
      name: name,
      data: data,
      crc: crc,
      check: check,
      raw: buf.slice(pos, i),
      flags: {
        critical: critical,
        public_: public_,
        conforming: conforming,
        copysafe: copysafe
      }
    });
  }

  return chunks;
};

PNG.prototype.parseChunks = function(chunks) {
  var i
    , chunk
    , name
    , data
    , p
    , idat
    , info;

  for (i = 0; i < chunks.length; i++) {
    chunk = chunks[i];
    name = chunk.id;
    data = chunk.data;
    info = {};
    switch (name) {
      case 'ihdr': {
        this.width = info.width = data.readUInt32BE(0);
        this.height = info.height = data.readUInt32BE(4);
        this.bitDepth = info.bitDepth = data.readUInt8(8);
        this.colorType = info.colorType = data.readUInt8(9);
        this.compression = info.compression = data.readUInt8(10);
        this.filter = info.filter = data.readUInt8(11);
        this.interlace = info.interlace = data.readUInt8(12);
        switch (this.bitDepth) {
          case 1: case 2: case 4: case 8: case 16: case 24: case 32: break;
          default: throw new Error('bad bit depth: ' + this.bitDepth);
        }
        switch (this.colorType) {
          case 0: case 2: case 3: case 4: case 6: break;
          default: throw new Error('bad color: ' + this.colorType);
        }
        switch (this.compression) {
          case 0: break;
          default: throw new Error('bad compression: ' + this.compression);
        }
        switch (this.filter) {
          case 0: case 1: case 2: case 3: case 4: break;
          default: throw new Error('bad filter: ' + this.filter);
        }
        switch (this.interlace) {
          case 0: case 1: break;
          default: throw new Error('bad interlace: ' + this.interlace);
        }
        break;
      }
      case 'plte': {
        this.palette = info.palette = [];
        for (p = 0; p < data.length; p += 3) {
          this.palette.push({
            r: data[p + 0],
            g: data[p + 1],
            b: data[p + 2],
            a: 255
          });
        }
        break;
      }
      case 'idat': {
        this.size = this.size || 0;
        this.size += data.length;
        this.idat = this.idat || [];
        this.idat.push(data);
        info.size = data.length;
        break;
      }
      case 'iend': {
        this.end = true;
        break;
      }
      case 'trns': {
        this.alpha = info.alpha = Array.prototype.slice.call(data);
        if (this.palette) {
          for (p = 0; p < data.length; p++) {
            if (!this.palette[p]) break;
            this.palette[p].a = data[p];
          }
        }
        break;
      }
      // https://wiki.mozilla.org/APNG_Specification
      case 'actl': {
        this.actl = info = {};
        this.frames = [];
        this.actl.numFrames = data.readUInt32BE(0);
        this.actl.numPlays = data.readUInt32BE(4);
        break;
      }
      case 'fctl': {
        // IDAT is the first frame depending on the order:
        // IDAT is a frame: acTL->fcTL->IDAT->[fcTL]->fdAT
        // IDAT is not a frame: acTL->IDAT->[fcTL]->fdAT
        if (!this.idat) {
          this.idat = [];
          this.frames.push({
            idat: true,
            fctl: info,
            fdat: this.idat
          });
        } else {
          this.frames.push({
            fctl: info,
            fdat: []
          });
        }
        info.sequenceNumber = data.readUInt32BE(0);
        info.width = data.readUInt32BE(4);
        info.height = data.readUInt32BE(8);
        info.xOffset = data.readUInt32BE(12);
        info.yOffset = data.readUInt32BE(16);
        info.delayNum = data.readUInt16BE(20);
        info.delayDen = data.readUInt16BE(22);
        info.disposeOp = data.readUInt8(24);
        info.blendOp = data.readUInt8(25);
        break;
      }
      case 'fdat': {
        info.sequenceNumber = data.readUInt32BE(0);
        info.data = data.slice(4);
        this.frames[this.frames.length - 1].fdat.push(info.data);
        break;
      }
    }
    chunk.info = info;
  }

  this._debug(chunks);

  if (this.frames) {
    this.frames = this.frames.map(function(frame, i) {
      frame.fdat = decompress(frame.fdat);
      if (!frame.fdat.length) throw new Error('no data');
      return frame;
    });
  }

  idat = decompress(this.idat);
  if (!idat.length) throw new Error('no data');

  return idat;
};

PNG.prototype.parseLines = function(data) {
  var pixels = []
    , x
    , p
    , prior
    , line
    , filter
    , samples
    , pendingSamples
    , ch
    , shiftStart
    , i
    , toShift
    , sample;

  this.sampleDepth =
    this.colorType === 0 ? 1
    : this.colorType === 2 ? 3
    : this.colorType === 3 ? 1
    : this.colorType === 4 ? 2
    : this.colorType === 6 ? 4
    : 1;
  this.bitsPerPixel = this.bitDepth * this.sampleDepth;
  this.bytesPerPixel = Math.ceil(this.bitsPerPixel / 8);
  this.wastedBits = ((this.width * this.bitsPerPixel) / 8) - ((this.width * this.bitsPerPixel / 8) | 0);
  this.byteWidth = Math.ceil(this.width * (this.bitsPerPixel / 8));

  this.shiftStart = ((this.bitDepth + (8 / this.bitDepth - this.bitDepth)) - 1) | 0;
  this.shiftMult = this.bitDepth >= 8 ? 0 : this.bitDepth;
  this.mask = this.bitDepth === 32 ? 0xffffffff : (1 << this.bitDepth) - 1;

  if (this.interlace === 1) {
    samples = this.sampleInterlacedLines(data);
    for (i = 0; i < samples.length; i += this.sampleDepth) {
      pixels.push(samples.slice(i, i + this.sampleDepth));
    }
    return pixels;
  }

  for (p = 0; p < data.length; p += this.byteWidth) {
    prior = line || [];
    filter = data[p++];
    line = data.slice(p, p + this.byteWidth);
    line = this.unfilterLine(filter, line, prior);
    samples = this.sampleLine(line);
    for (i = 0; i < samples.length; i += this.sampleDepth) {
      pixels.push(samples.slice(i, i + this.sampleDepth));
    }
  }

  return pixels;
};

PNG.prototype.unfilterLine = function(filter, line, prior) {
  for (var x = 0; x < line.length; x++) {
    if (filter === 0) {
      // line[x] = line[x];
    } else if (filter === 1) {
      line[x] = this.filters.sub(x, line, prior, this.bytesPerPixel);
    } else if (filter === 2) {
      line[x] = this.filters.up(x, line, prior, this.bytesPerPixel);
    } else if (filter === 3) {
      line[x] = this.filters.average(x, line, prior, this.bytesPerPixel);
    } else if (filter === 4) {
      line[x] = this.filters.paeth(x, line, prior, this.bytesPerPixel);
    }
  }
  return line;
};

PNG.prototype.sampleLine = function(line, width) {
  var samples = []
    , x = 0
    , pendingSamples
    , ch
    , i
    , sample
    , shiftStart
    , toShift;

  while (x < line.length) {
    pendingSamples = this.sampleDepth;
    while (pendingSamples--) {
      ch = line[x];
      if (this.bitDepth === 16) {
        ch = (ch << 8) | line[++x];
      } else if (this.bitDepth === 24) {
        ch = (ch << 16) | (line[++x] << 8) | line[++x];
      } else if (this.bitDepth === 32) {
        ch = (ch << 24) | (line[++x] << 16) | (line[++x] << 8) | line[++x];
      } else if (this.bitDepth > 32) {
        throw new Error('bitDepth ' + this.bitDepth + ' unsupported.');
      }
      shiftStart = this.shiftStart;
      toShift = shiftStart - (x === line.length - 1 ? this.wastedBits : 0);
      for (i = 0; i <= toShift; i++) {
        sample = (ch >> (this.shiftMult * shiftStart)) & this.mask;
        if (this.colorType !== 3) {
          if (this.bitDepth < 8) { // <= 8 would work too, doesn't matter
            // sample = sample * (0xff / this.mask) | 0; // would work too
            sample *= 0xff / this.mask;
            sample |= 0;
          } else if (this.bitDepth > 8) {
            sample = (sample / this.mask) * 255 | 0;
          }
        }
        samples.push(sample);
        shiftStart--;
      }
      x++;
    }
  }

  // Needed for deinterlacing?
  if (width != null) {
    samples = samples.slice(0, width * this.sampleDepth);
  }

  return samples;
};

// http://www.w3.org/TR/PNG-Filters.html
PNG.prototype.filters = {
  sub: function Sub(x, line, prior, bpp) {
    if (x < bpp) return line[x];
    return (line[x] + line[x - bpp]) % 256;
  },
  up: function Up(x, line, prior, bpp) {
    return (line[x] + (prior[x] || 0)) % 256;
  },
  average: function Average(x, line, prior, bpp) {
    if (x < bpp) return Math.floor((prior[x] || 0) / 2);
    // if (x < bpp) return (prior[x] || 0) >> 1;
    return (line[x]
      + Math.floor((line[x - bpp] + prior[x]) / 2)
      // + ((line[x - bpp] + prior[x]) >> 1)
    ) % 256;
  },
  paeth: function Paeth(x, line, prior, bpp) {
    if (x < bpp) return prior[x] || 0;
    return (line[x] + this._predictor(
      line[x - bpp], prior[x] || 0, prior[x - bpp] || 0
    )) % 256;
  },
  _predictor: function PaethPredictor(a, b, c) {
    // a = left, b = above, c = upper left
    var p = a + b - c
      , pa = Math.abs(p - a)
      , pb = Math.abs(p - b)
      , pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }
};

/**
 * Adam7 deinterlacing ported to javascript from PyPNG:
 * pypng - Pure Python library for PNG image encoding/decoding
 * Copyright (c) 2009-2015, David Jones (MIT License).
 * https://github.com/drj11/pypng
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation files
 * (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

PNG.prototype.sampleInterlacedLines = function(raw) {
  var psize
    , vpr
    , samples
    , source_offset
    , i
    , pass
    , xstart
    , ystart
    , xstep
    , ystep
    , recon
    , ppr
    , row_size
    , y
    , filter_type
    , scanline
    , flat
    , offset
    , k
    , end_offset
    , skip
    , j
    , k
    , f;

  var adam7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2]
  ];

  // Fractional bytes per pixel
  psize = (this.bitDepth / 8) * this.sampleDepth;

  // Values per row (of the target image)
  vpr = this.width * this.sampleDepth;

  // Make a result array, and make it big enough. Interleaving
  // writes to the output array randomly (well, not quite), so the
  // entire output array must be in memory.
  samples = new Buffer(vpr * this.height);
  samples.fill(0);

  source_offset = 0;

  for (i = 0; i < adam7.length; i++) {
    pass = adam7[i];
    xstart = pass[0];
    ystart = pass[1];
    xstep = pass[2];
    ystep = pass[3];
    if (xstart >= this.width) continue;
    // The previous (reconstructed) scanline. Empty array at the
    // beginning of a pass to indicate that there is no previous
    // line.
    recon = [];
    // Pixels per row (reduced pass image)
    ppr = Math.ceil((this.width - xstart) / xstep);
    // Row size in bytes for this pass.
    row_size = Math.ceil(psize * ppr);
    for (y = ystart; y < this.height; y += ystep) {
      filter_type = raw[source_offset];
      source_offset += 1;
      scanline = raw.slice(source_offset, source_offset + row_size);
      source_offset += row_size;
      recon = this.unfilterLine(filter_type, scanline, recon);
      // Convert so that there is one element per pixel value
      flat = this.sampleLine(recon, ppr);
      if (xstep === 1) {
        assert.equal(xstart, 0);
        offset = y * vpr;
        for (k = offset, f = 0; k < offset + vpr; k++, f++) {
          samples[k] = flat[f];
        }
      } else {
        offset = y * vpr + xstart * this.sampleDepth;
        end_offset = (y + 1) * vpr;
        skip = this.sampleDepth * xstep;
        for (j = 0; j < this.sampleDepth; j++) {
          for (k = offset + j, f = j; k < end_offset; k += skip, f += this.sampleDepth) {
            samples[k] = flat[f];
          }
        }
      }
    }
  }

  return samples;
};

PNG.prototype.createBitmap = function(pixels) {
  var bmp = [];

  if (this.colorType === 0) {
    pixels = pixels.map(function(sample) {
      return { r: sample[0], g: sample[0], b: sample[0], a: 255 };
    });
  } else if (this.colorType === 2) {
    pixels = pixels.map(function(sample) {
      return { r: sample[0], g: sample[1], b: sample[2], a: 255 };
    });
  } else if (this.colorType === 3) {
    pixels = pixels.map(function(sample) {
      if (!this.palette[sample[0]]) throw new Error('bad palette index');
      return this.palette[sample[0]];
    }, this);
  } else if (this.colorType === 4) {
    pixels = pixels.map(function(sample) {
      return { r: sample[0], g: sample[0], b: sample[0], a: sample[1] };
    });
  } else if (this.colorType === 6) {
    pixels = pixels.map(function(sample) {
      return { r: sample[0], g: sample[1], b: sample[2], a: sample[3] };
    });
  }

  for (var i = 0; i < pixels.length; i += this.width) {
    bmp.push(pixels.slice(i, i + this.width));
  }

  return bmp;
};

PNG.prototype.createCellmap = function(bmp, options) {
  var bmp = bmp || this.bmp
    , options = options || this.options
    , cellmap = []
    , scale = options.cellmapScale || this.defaultScale
    , height = bmp.length
    , width = bmp[0].length
    , cmwidth = options.cellmapWidth
    , cmheight = options.cellmapHeight
    , line
    , x
    , y
    , scale
    , xs
    , ys;

  if (cmwidth) {
    scale = cmwidth / width;
  } else if (cmheight) {
    scale = cmheight / height;
  }

  ys = Math.ceil(height / (height * scale));
  xs = Math.ceil(width / (width * scale));

  // ys++;
  // xs++;

  // add a reducePixels() method here
  for (y = 0; y < bmp.length; y += ys) {
    line = [];
    if (cmheight && cellmap.length === cmheight) break;
    cellmap.push(line);
    for (x = 0; x < bmp[y].length; x += xs) {
      if (cmwidth && line.length === cmwidth) break;
      line.push(bmp[y][x]);
    }
  }

  return cellmap;
};

PNG.prototype.renderANSI = function(bmp) {
  var self = this
    , out = '';

  bmp.forEach(function(line, y) {
    line.forEach(function(pixel, x) {
      var outch = self.getOutch(x, y, line, pixel);
      out += self.pixelToSGR(pixel, outch);
    });
    out += '\n';
  });

  return out;
};

PNG.prototype.renderContent = function(bmp, el) {
  var self = this
    , out = '';

  bmp.forEach(function(line, y) {
    line.forEach(function(pixel, x) {
      var outch = self.getOutch(x, y, line, pixel);
      out += self.pixelToTags(pixel, outch);
    });
    out += '\n';
  });

  el.setContent(out);

  return out;
};

PNG.prototype.renderScreen = function(bmp, screen, xi, xl, yi, yl) {
  var self = this
    , lines = screen.lines
    , cellLines
    , y
    , yy
    , x
    , xx
    , alpha
    , attr
    , ch;

  cellLines = bmp.reduce(function(cellLines, line, y) {
    var cellLine = [];
    line.forEach(function(pixel, x) {
      var outch = self.getOutch(x, y, line, pixel);
      var cell = self.pixelToCell(pixel, outch);
      cellLine.push(cell);
    });
    cellLines.push(cellLine);
    return cellLines;
  }, []);

  for (y = yi; y < yl; y++) {
    yy = y - yi;
    for (x = xi; x < xl; x++) {
      xx = x - xi;
      if (lines[y] && lines[y][x] && cellLines[yy] && cellLines[yy][xx]) {
        alpha = cellLines[yy][xx].pop();
        // completely transparent
        if (alpha === 0.0) {
          continue;
        }
        // translucency / blending
        if (alpha < 1.0) {
          attr = cellLines[yy][xx][0];
          ch = cellLines[yy][xx][1];
          lines[y][x][0] = this.colors.blend(lines[y][x][0], attr, alpha);
          if (ch !== ' ') lines[y][x][1] = ch;
          lines[y].dirty = true;
          continue;
        }
        // completely opaque
        lines[y][x] = cellLines[yy][xx];
        lines[y].dirty = true;
      }
    }
  }
};

PNG.prototype.renderElement = function(bmp, el) {
  var xi = el.aleft + el.ileft, xl = el.aleft + el.width - el.iright
    , yi = el.atop + el.itop, yl = el.atop + el.height - el.ibottom;

  return this.renderScreen(bmp, el.screen, xi, xl, yi, yl);
};

PNG.prototype.pixelToSGR = function(pixel, ch) {
  var bga = 1.0
    , fga = 0.5
    , a = pixel.a / 255
    , bg
    , fg;

  bg = this.colors.match(
    pixel.r * a * bga | 0,
    pixel.g * a * bga | 0,
    pixel.b * a * bga | 0);

  if (ch && this.options.ascii) {
    fg = this.colors.match(
      pixel.r * a * fga | 0,
      pixel.g * a * fga | 0,
      pixel.b * a * fga | 0);
    if (a === 0) {
      return '\x1b[38;5;' + fg + 'm' + ch + '\x1b[m';
    }
    return '\x1b[38;5;' + fg + 'm\x1b[48;5;' + bg + 'm' + ch + '\x1b[m';
  }

  if (a === 0) return ' ';

  return '\x1b[48;5;' + bg + 'm \x1b[m';
};

PNG.prototype.pixelToTags = function(pixel, ch) {
  var bga = 1.0
    , fga = 0.5
    , a = pixel.a / 255
    , bg
    , fg;

  bg = this.colors.RGBtoHex(
    pixel.r * a * bga | 0,
    pixel.g * a * bga | 0,
    pixel.b * a * bga | 0);

  if (ch && this.options.ascii) {
    fg = this.colors.RGBtoHex(
      pixel.r * a * fga | 0,
      pixel.g * a * fga | 0,
      pixel.b * a * fga | 0);
    if (a === 0) {
      return '{' + fg + '-fg}' + ch + '{/}';
    }
    return '{' + fg + '-fg}{' + bg + '-bg}' + ch + '{/}';
  }

  if (a === 0) return ' ';

  return '{' + bg + '-bg} {/' + bg + '-bg}';
};

PNG.prototype.pixelToCell = function(pixel, ch) {
  var bga = 1.0
    , fga = 0.5
    , a = pixel.a / 255
    , bg
    , fg;

  bg = this.colors.match(
    pixel.r * bga | 0,
    pixel.g * bga | 0,
    pixel.b * bga | 0);

  if (ch && this.options.ascii) {
    fg = this.colors.match(
      pixel.r * fga | 0,
      pixel.g * fga | 0,
      pixel.b * fga | 0);
  } else {
    fg = 0x1ff;
    ch = null;
  }

  // if (a === 0) bg = 0x1ff;

  return [(0 << 18) | (fg << 9) | (bg << 0), ch || ' ', a];
};

// Taken from libcaca:
PNG.prototype.getOutch = (function() {
  var dchars = '????8@8@#8@8##8#MKXWwz$&%x><\\/xo;+=|^-:i\'.`,  `.        ';

  var luminance = function(pixel) {
    var a = pixel.a / 255
      , r = pixel.r * a
      , g = pixel.g * a
      , b = pixel.b * a
      , l = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    return l / 255;
  };

  return function(x, y, line, pixel) {
    var lumi = luminance(pixel)
      , outch = dchars[lumi * (dchars.length - 1) | 0];

    return outch;
  };
})();

PNG.prototype.compileFrames = function(frames) {
  return this.options.optimization === 'mem'
    ? this.compileFrames_lomem(frames)
    : this.compileFrames_locpu(frames);
};

PNG.prototype.compileFrames_lomem = function(frames) {
  if (!this.actl) return;
  return frames.map(function(frame, i) {
    this.width = frame.fctl.width;
    this.height = frame.fctl.height;

    var pixels = frame._pixels || this.parseLines(frame.fdat)
      , bmp = frame._bmp || this.createBitmap(pixels)
      , fc = frame.fctl;

    return {
      actl: this.actl,
      fctl: frame.fctl,
      delay: (fc.delayNum / (fc.delayDen || 100)) * 1000 | 0,
      bmp: bmp
    };
  }, this);
};

PNG.prototype.compileFrames_locpu = function(frames) {
  if (!this.actl) return;

  this._curBmp = null;
  this._lastBmp = null;

  return frames.map(function(frame, i) {
    this.width = frame.fctl.width;
    this.height = frame.fctl.height;

    var pixels = frame._pixels || this.parseLines(frame.fdat)
      , bmp = frame._bmp || this.createBitmap(pixels)
      , renderBmp = this.renderFrame(bmp, frame, i)
      , cellmap = this.createCellmap(renderBmp)
      , fc = frame.fctl;

    return {
      actl: this.actl,
      fctl: frame.fctl,
      delay: (fc.delayNum / (fc.delayDen || 100)) * 1000 | 0,
      bmp: renderBmp,
      cellmap: cellmap
    };
  }, this);
};

PNG.prototype.renderFrame = function(bmp, frame, i) {
  var renderBmp = bmp
    , first = this.frames[0]
    , last = this.frames[i - 1]
    , fc = frame.fctl
    , xo = fc.xOffset
    , yo = fc.yOffset
    , lxo
    , lyo
    , ops
    , x
    , y
    , p;

  ops = (xo + yo + fc.blendOp)
    + (last ? last.fctl.disposeOp : 0)
    + ~~(fc.width !== first.fctl.width)
    + ~~(fc.height !== first.fctl.height);

  if (!this._curBmp) {
    this._curBmp = [];
    for (y = 0; y < first.fctl.height; y++) {
      var line = [];
      for (x = 0; x < first.fctl.width; x++) {
        p = bmp[y][x];
        line.push({ r: p.r, g: p.g, b: p.b, a: p.a });
      }
      this._curBmp.push(line);
    }
  }

  if (last && ops) {
    if (last.fctl.disposeOp) {
      lxo = last.fctl.xOffset;
      lyo = last.fctl.yOffset;
      for (y = 0; y < last.fctl.height; y++) {
        for (x = 0; x < last.fctl.width; x++) {
          if (last.fctl.disposeOp === 1) {
            this._curBmp[lyo + y][lxo + x] = { r: 0, g: 0, b: 0, a: 0 };
          } else if (last.fctl.disposeOp === 2) {
            p = this._lastBmp[y][x];
            this._curBmp[lyo + y][lxo + x] = { r: p.r, g: p.g, b: p.b, a: p.a };
          }
        }
      }
    }
    for (y = 0; y < frame.fctl.height; y++) {
      for (x = 0; x < frame.fctl.width; x++) {
        p = bmp[y][x];
        if (fc.blendOp === 0) {
          this._curBmp[yo + y][xo + x] = { r: p.r, g: p.g, b: p.b, a: p.a };
        } else if (fc.blendOp === 1) {
          if (bmp[y][x].a !== 0) {
            this._curBmp[yo + y][xo + x] = { r: p.r, g: p.g, b: p.b, a: p.a };
          }
        }
      }
    }
    renderBmp = this._curBmp;
  }

  this._lastBmp = bmp;

  return renderBmp;
};

PNG.prototype._animate = function(callback) {
  if (!this.frames) {
    return callback(this.bmp, this.cellmap);
  }

  var self = this
    , numPlays = this.actl.numPlays || Infinity
    , running = 0
    , i = -1;

  this._curBmp = null;
  this._lastBmp = null;

  var next_lomem = function() {
    if (!running) return;
    var frame = self.frames[++i];
    if (!frame) {
      if (!--numPlays) return callback();
      i = -1;
      // XXX may be able to optimize by only setting the self._curBmp once???
      self._curBmp = null;
      self._lastBmp = null;
      return setImmediate(next);
    }

    var bmp = frame.bmp
      , renderBmp = self.renderFrame(bmp, frame, i)
      , cellmap = self.createCellmap(renderBmp);

    callback(renderBmp, cellmap);
    return setTimeout(next, frame.delay);
  };

  var next_locpu = function() {
    if (!running) return;
    var frame = self.frames[++i];
    if (!frame) {
      if (!--numPlays) return callback();
      i = -1;
      return setImmediate(next);
    }
    callback(frame.bmp, frame.cellmap);
    return setTimeout(next, frame.delay);
  };

  var next = this.options.optimization === 'mem'
    ? next_lomem
    : next_locpu;

  this._control = function(state) {
    if (state === -1) {
      i = -1;
      self._curBmp = null;
      self._lastBmp = null;
      running = 0;
      callback(self.frames[0].bmp,
        self.frames[0].cellmap || self.createCellmap(self.frames[0].bmp));
      return;
    }
    if (state === running) return;
    running = state;
    return next();
  };

  this._control(1);
};

PNG.prototype.play = function(callback) {
  if (!this._control || callback) {
    this.stop();
    return this._animate(callback);
  }
  this._control(1);
};

PNG.prototype.pause = function() {
  if (!this._control) return;
  this._control(0);
};

PNG.prototype.stop = function() {
  if (!this._control) return;
  this._control(-1);
};

PNG.prototype.toPNG = function() {
  var options = this.options
    , file = this.file
    , format = this.format
    , buf
    , img
    , gif;

  if (format !== 'gif') {
    buf = exec('convert',
      [format + ':' + file, 'png:-'],
      { stdio: ['ignore', 'pipe', 'ignore']});
    img = PNG(buf, options);
    img.file = file;
    return img;
  }

  gif = GIF(file, options);

  this.width = gif.screenWidth;
  this.height = gif.screenHeight;
  this.frames = [];

  for (var i = 0; i < gif.images.length; i++) {
    var img = gif.images[i];
    // Convert from gif disposal to png disposal. See:
    // http://www.w3.org/Graphics/GIF/spec-gif89a.txt
    var disposeOp = Math.max(0, (gif.disposeMethod || 0) - 1);
    if (disposeOp > 2) disposeOp = 0;
    this.frames.push({
      fctl: {
        sequenceNumber: i,
        width: img.width,
        height: img.height,
        xOffset: img.left,
        yOffset: img.top,
        delayNum: gif.delay,
        delayDen: 100,
        disposeOp: disposeOp,
        blendOp: 1
      },
      fdat: [],
      _pixels: [],
      _bmp: img.bmp
    });
  }

  this.bmp = this.frames[0]._bmp;
  this.cellmap = this.createCellmap(this.bmp);

  if (this.frames.length > 1) {
    this.actl = { numFrames: gif.images.length, numPlays: gif.numPlays || 0 };
    this.frames = this.compileFrames(this.frames);
  } else {
    this.frames = undefined;
  }

  return this;
};

// Convert a gif to an apng using imagemagick. Unfortunately imagemagick
// doesn't support apngs, so we coalesce the gif frames into one image and then
// slice them into frames.
PNG.prototype.gifMagick = function() {
  var options = this.options
    , file = this.file
    , format = this.format
    , buf
    , fmt
    , img
    , frames
    , frame
    , width
    , height
    , iwidth
    , twidth
    , i
    , lines
    , line
    , x
    , y;

  buf = exec('convert',
    [format + ':' + file, '-coalesce', '+append', 'png:-']);

  fmt = '{"W":%W,"H":%H,"w":%w,"h":%h,"d":%T,"x":"%X","y":"%Y"},'
  frames = exec('identify', ['-format', fmt, format + ':' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  frames = JSON.parse('[' + frames.trim().slice(0, -1) + ']');

  img = PNG(buf, options);
  img.file = file;
  Object.keys(img).forEach(function(key) {
    this[key] = img[key];
  }, this);

  width = frames[0].W;
  height = frames[0].H;
  iwidth = 0;
  twidth = 0;

  this.width = width;
  this.height = height;

  this.frames = [];

  for (i = 0; i < frames.length; i++) {
    frame = frames[i];
    frame.x = +frame.x;
    frame.y = +frame.y;

    iwidth = twidth;
    twidth += width;

    lines = [];
    for (y = frame.y; y < height; y++) {
      line = [];
      for (x = iwidth + frame.x; x < twidth; x++) {
        line.push(img.bmp[y][x]);
      }
      lines.push(line);
    }

    this.frames.push({
      fctl: {
        sequenceNumber: i,
        width: frame.w,
        height: frame.h,
        xOffset: frame.x,
        yOffset: frame.y,
        delayNum: frame.d,
        delayDen: 100,
        disposeOp: 0,
        blendOp: 0
      },
      fdat: [],
      _pixels: [],
      _bmp: lines
    });
  }

  this.bmp = this.frames[0]._bmp;
  this.cellmap = this.createCellmap(this.bmp);

  if (this.frames.length > 1) {
    this.actl = { numFrames: frames.length, numPlays: 0 };
    this.frames = this.compileFrames(this.frames);
  } else {
    this.frames = undefined;
  }

  return this;
};

PNG.prototype._debug = function() {
  if (!this.options.log) return;
  return this.options.log.apply(null, arguments);
};

/**
 * Helpers
 */

function decompress(buffers) {
  return zlib.inflateSync(new Buffer(buffers.reduce(function(out, data) {
    return out.concat(Array.prototype.slice.call(data));
  }, [])));
}

function crc32() {
  return 0;
}

function dump() {
  Array.prototype.slice.call(arguments).forEach(function(v) { console.log(v) });
  return process.exit(0);
}

/**
 * Expose
 */

exports = PNG;
exports.png = PNG;
exports.gif = GIF;

module.exports = exports;
