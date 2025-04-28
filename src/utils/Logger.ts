export enum Colors {
  black = '30',
  red = '31',
  green = '32',
  yellow = '33',
  blue = '34',
  magenta = '35',
  cyan = '36',
  white = '37'
}

class Logger {
  log(colorCode: string, msg: string) {
    console.log(`\x1b[${colorCode}m${msg}\x1b[0m`);
  }

  black(msg: string) {
    this.log(Colors.black, msg);
  }

  red(msg: string) {
    this.log(Colors.red, msg);
  }

  green(msg: string) {
    this.log(Colors.green, msg);
  }

  yellow(msg: string) {
    this.log(Colors.yellow, msg);
  }

  blue(msg: string) {
    this.log(Colors.blue, msg);
  }

  magenta(msg: string) {
    this.log(Colors.magenta, msg);
  }

  cyan(msg: string) {
    this.log(Colors.cyan, msg);
  }

  white(msg: string) {
    this.log(Colors.white, msg);
  }
}

export default new Logger();
