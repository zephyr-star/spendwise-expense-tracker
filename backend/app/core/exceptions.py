"""Custom exception classes."""
from fastapi import status


class AppException(Exception):
    def __init__(self, message: str, code: str = "ERROR", status_code: int = status.HTTP_400_BAD_REQUEST):
        self.message = message
        self.code = code
        self.status_code = status_code
        super().__init__(message)