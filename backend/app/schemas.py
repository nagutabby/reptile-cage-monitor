from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from .domain import Environment, Humidity, Temperature


class ReadingIn(BaseModel):
    temp_c: float
    humidity: float
    is_light_on: bool | None = None
    is_heater_on: bool | None = None

    @field_validator("temp_c")
    @classmethod
    def _validate_temp_c(cls, v: float) -> float:
        Temperature(v)  # 範囲外ならValueError -> FastAPIが422にする
        return v

    @field_validator("humidity")
    @classmethod
    def _validate_humidity(cls, v: float) -> float:
        Humidity(v)
        return v

    def to_environment(self) -> Environment:
        return Environment(Temperature(self.temp_c), Humidity(self.humidity))


class ReadingOut(BaseModel):
    id: int
    temp_c: float
    humidity: float
    recorded_at: str


class DeviceStateOut(BaseModel):
    is_light_on: bool | None
    is_light_on_changed_at: str | None
    is_heater_on: bool | None
    is_heater_on_changed_at: str | None


class IoTTelemetryIn(BaseModel):
    event_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9:_-]+$")
    observed_at: datetime
    temp_c: float
    humidity: float

    @field_validator("temp_c")
    @classmethod
    def _validate_temp_c(cls, value: float) -> float:
        Temperature(value)
        return value

    @field_validator("humidity")
    @classmethod
    def _validate_humidity(cls, value: float) -> float:
        Humidity(value)
        return value

    @field_validator("observed_at")
    @classmethod
    def _aware_timestamp(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("observed_at must include a timezone")
        return value

    def to_environment(self) -> Environment:
        return Environment(Temperature(self.temp_c), Humidity(self.humidity))


class IoTStateIn(BaseModel):
    event_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9:_-]+$")
    observed_at: datetime
    is_light_on: bool
    is_heater_on: bool

    @field_validator("observed_at")
    @classmethod
    def _aware_timestamp(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("observed_at must include a timezone")
        return value
