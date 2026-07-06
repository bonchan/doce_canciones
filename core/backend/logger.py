import logging

class ColorFormatter(logging.Formatter):
    grey = "\x1b[38;20m"
    cyan = "\x1b[36;20m"
    yellow = "\x1b[33;20m"
    red = "\x1b[31;20m"
    bold_red = "\x1b[31;1m"
    reset = "\x1b[0m"
    
    # Crucial: %(filename)s will still show the file that *called* the log, not logger.py!
    FORMAT = "%(levelname)-7s \x1b[90m[%(filename)s:%(lineno)d]\x1b[0m %(message)s"

    FORMATS = {
        logging.DEBUG: grey + FORMAT + reset,
        logging.INFO: cyan + FORMAT + reset,
        logging.WARNING: yellow + FORMAT + reset,
        logging.ERROR: red + FORMAT + reset,
        logging.CRITICAL: bold_red + FORMAT + reset
    }

    def format(self, record):
        log_fmt = self.FORMATS.get(record.levelno)
        formatter = logging.Formatter(log_fmt)
        return formatter.format(record)

# Initialize and export a shared configured instance
logger = logging.getLogger("Watchdog")
logger.setLevel(logging.DEBUG)

if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setLevel(logging.DEBUG)
    ch.setFormatter(ColorFormatter())
    logger.addHandler(ch)